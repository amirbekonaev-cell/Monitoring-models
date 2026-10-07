import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Sentiment } from '../mentions/mention.entity';
import { CuratedLinkStatus } from './curated-link.entity';
import { subtractCalendarDays, zonedDateString } from './curated-date.util';
import { CuratedMentionsService } from './curated-mentions.service';
import { CURATED_SENTIMENT_TO_ENUM, CuratedMention, CuratedStatus } from './curated-mentions';
import {
  CardSetStats,
  CuratedMentionView,
  CuratedSearchResult,
  CuratedSearchSource,
  PoolStats,
  zeroedLinkStatusRecord,
  zeroedSentimentRecord,
} from './curated-search.types';

/** The one card status that never reaches /search — an explicit duplicate of another card. */
const HIDDEN_STATUS: CuratedStatus = 'duplicate';

const MS_PER_DAY = 86_400_000;

/**
 * /search and /status over the hand-written card set in curated-mentions.data.json — the source
 * the Telegram bot actually uses.
 *
 * Every card already carries its title, date, ~50-word summary and sentiment, written and checked
 * by a human. So this service does exactly one thing: filter by the period window, sort, count. No
 * DB query, no page download, no OpenAI call — nothing that can fail or take seconds, which is the
 * whole point: the bot answers from inside a Telegram handler (on Vercel, a 60s function) and must
 * work with no OPENAI_API_KEY in the environment at all.
 *
 * It deliberately does NOT read the `mentions` table. That table only ever held copies of these
 * same cards, put there by `npm run seed:curated` — reading it bought nothing and cost a
 * deployment step, a `/reset` that could wipe the cards, and a lazy-processing path that paid
 * OpenAI to re-derive what the JSON already states. The DB pool is still readable through
 * CuratedSearchService, which the CLI inspection scripts use.
 *
 * Privacy: `CuratedMentionView` has no url field and nothing here puts one into a text field — a
 * /search message must never leak a pool link (see README "Приватность").
 */
@Injectable()
export class CuratedJsonSearchService implements CuratedSearchSource {
  private readonly logger = new Logger(CuratedJsonSearchService.name);

  constructor(
    private readonly cards: CuratedMentionsService,
    private readonly config: ConfigService,
  ) {
    const stats = this.cardSetStats();
    this.logger.log(
      '/search и /status читают готовые карточки из curated-mentions.data.json: ' +
        `${stats.shown} доступно, скрыто дубликатов ${stats.duplicates}, OpenAI не используется`,
    );
  }

  private get timezone(): string {
    return this.config.get<string>('curated.timezone') || 'Asia/Almaty';
  }

  /** Same window arithmetic as the DB source: calendar days in SEARCH_TIMEZONE, not UTC ms. */
  private dateWindow(periodDays: number, now: Date): { dateFrom: string; dateTo: string } {
    const dateTo = zonedDateString(now, this.timezone);
    return { dateFrom: subtractCalendarDays(dateTo, periodDays), dateTo };
  }

  /** Cards /search may show: the deliberate duplicate must not appear twice in one period. */
  private visibleCards(): CuratedMention[] {
    return this.cards.all().filter((card) => card.status !== HIDDEN_STATUS);
  }

  /**
   * Dated visible cards inside the window, newest first.
   *
   * The comparison is a plain string compare on "YYYY-MM-DD", and that IS the calendar-day
   * comparison the DB source needs an `AT TIME ZONE` cast for: a card date has no time component
   * to shift, so there is no instant to re-zone — the date printed on the article is the date, in
   * Almaty or anywhere else.
   */
  private inWindow(periodDays: number, now: Date): CuratedMention[] {
    const { dateFrom, dateTo } = this.dateWindow(periodDays, now);
    return this.visibleCards()
      .filter((card) => card.publishedAt !== null && card.publishedAt >= dateFrom && card.publishedAt <= dateTo)
      .sort(compareByDateDescThenId);
  }

  async search(periodDays: number, now: Date = new Date()): Promise<CuratedSearchResult> {
    const { dateFrom, dateTo } = this.dateWindow(periodDays, now);
    const items = this.inWindow(periodDays, now);

    const bySentiment = zeroedSentimentRecord();
    for (const card of items) {
      bySentiment[cardSentiment(card)] += 1;
    }

    return {
      periodDays,
      dateFrom,
      dateTo,
      total: items.length,
      bySentiment,
      undatedCount: this.visibleCards().filter((card) => card.publishedAt === null).length,
      pool: await this.getPoolStats(),
    };
  }

  /**
   * One page of in-window cards, `publishedAt DESC, id ASC`. `offset` counts from the start of the
   * whole window (matching the running total the "Показать ещё" button reports), not from the end
   * of the previous page.
   *
   * `summary` is handed over whole, never truncated: it is a finished ~50-word text written by a
   * human, and the DB source's 250-character display cap cut it mid-sentence. What bounds the
   * message instead is how many items the page packer fits under SEARCH_MESSAGE_CHAR_LIMIT.
   */
  async findPage(
    periodDays: number,
    offset: number,
    limit: number,
    now: Date = new Date(),
  ): Promise<CuratedMentionView[]> {
    const items = this.inWindow(periodDays, now);
    const safeOffset = Number.isFinite(offset) && offset > 0 ? Math.floor(offset) : 0;
    const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 0;
    const timeZone = this.timezone;
    return items.slice(safeOffset, safeOffset + safeLimit).map((card) => toMentionView(card, timeZone));
  }

  async getPoolStats(): Promise<PoolStats> {
    const cards = this.cardSetStats();
    const dated = this.visibleCards()
      .map((card) => card.publishedAt)
      .filter((date): date is string => date !== null)
      .sort();

    return {
      // The card set IS the pool now: nothing is queued for processing, so every link-status
      // counter other than "processed" is structurally zero. /status renders the `cards`
      // breakdown instead of these — see buildStatusText.
      totalLinks: cards.total,
      byStatus: {
        ...zeroedLinkStatusRecord(),
        [CuratedLinkStatus.PROCESSED]: cards.shown,
        [CuratedLinkStatus.EXCLUDED]: cards.duplicates,
      },
      mentionsTotal: cards.shown,
      undatedMentions: cards.shown - dated.length,
      firstArticleDate: dated.length > 0 ? cardDate(dated[0], this.timezone) : null,
      lastArticleDate: dated.length > 0 ? cardDate(dated[dated.length - 1], this.timezone) : null,
      // Nothing is ever "processed" here: the cards are written by hand, not derived at runtime.
      lastProcessedAt: null,
      cards,
    };
  }

  private cardSetStats(): CardSetStats {
    const visible = this.visibleCards();
    const byStatus: Record<CuratedStatus, number> = { verified: 0, partial: 0, unverified: 0, duplicate: 0 };
    const bySentiment = zeroedSentimentRecord();
    for (const card of visible) {
      byStatus[card.status] += 1;
      bySentiment[cardSentiment(card)] += 1;
    }
    const total = this.cards.all().length;
    return { total, shown: visible.length, duplicates: total - visible.length, byStatus, bySentiment };
  }
}

function cardSentiment(card: CuratedMention): Sentiment {
  return CURATED_SENTIMENT_TO_ENUM[card.sentiment] ?? Sentiment.UNDEFINED;
}

function compareByDateDescThenId(a: CuratedMention, b: CuratedMention): number {
  const byDate = (b.publishedAt ?? '').localeCompare(a.publishedAt ?? '');
  // Same-day cards would otherwise come out in whatever order the JSON happens to list them, which
  // makes the "Показать ещё" offsets differ between two calls for the same period.
  return byDate !== 0 ? byDate : a.id.localeCompare(b.id);
}

/**
 * An instant that renders back as `iso` when formatted in `timeZone` — which is exactly what the
 * message formatter does to it (formatDateInTimezone, see curated-message.util.ts).
 *
 * A card carries a calendar date only ("2026-08-18"), with no time of day, so some instant has to
 * be invented for it, and the naive choices are all wrong somewhere: midnight UTC reads as the
 * previous day anywhere west of Greenwich, and noon UTC still reads as the next day in UTC+13/+14
 * (Pacific/Kiritimati). So pick noon UTC, ask the zone what day that actually is, and shift by the
 * whole-day difference — one correction always suffices, because no zone is more than 14h from UTC
 * and noon leaves 12h of slack on each side.
 */
function cardDate(iso: string, timeZone: string): Date {
  const noonUtc = new Date(`${iso}T12:00:00Z`);
  const rendered = zonedDateString(noonUtc, timeZone);
  if (rendered === iso) {
    return noonUtc;
  }
  const dayDiff = Math.round((Date.parse(`${rendered}T00:00:00Z`) - Date.parse(`${iso}T00:00:00Z`)) / MS_PER_DAY);
  return new Date(noonUtc.getTime() - dayDiff * MS_PER_DAY);
}

function toMentionView(card: CuratedMention, timeZone: string): CuratedMentionView {
  return {
    id: card.id,
    title: card.title,
    // The publication's name, never its domain or URL — see the class comment on privacy.
    sourceLabel: card.sourceName,
    publishedAt: card.publishedAt ? cardDate(card.publishedAt, timeZone) : null,
    sentiment: cardSentiment(card),
    summary: card.summary?.trim() ? card.summary.trim() : null,
    // There is no raw article text in the JSON — the summary IS the text, so there is nothing to
    // fall back to and the formatter never reaches its snippet branch for these items.
    snippet: null,
  };
}
