import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Mention, Sentiment } from '../mentions/mention.entity';
import { CuratedLink, CuratedLinkStatus } from './curated-link.entity';
import { CuratedIngestService } from './curated-ingest.service';
import { subtractCalendarDays, zonedDateString } from './curated-date.util';
import { extractDateFromUrl } from './curated-article-date.util';
import { truncateText } from './text.util';

export const CURATED_DEFAULT_SOURCE_LABEL = 'Подборка материалов';
const SUMMARY_DISPLAY_LENGTH = 250;
const SNIPPET_DISPLAY_LENGTH = 200;
/** Generous enough to cover any realistic /search message page (see curated-message.util.ts's
 *  greedy packing) without an extra round-trip — the whole pool is a few hundred links at most. */
const PAGE_FETCH_LIMIT = 500;

export interface PoolStats {
  totalLinks: number;
  byStatus: Record<CuratedLinkStatus, number>;
  mentionsTotal: number;
  undatedMentions: number;
  firstArticleDate: Date | null;
  lastArticleDate: Date | null;
  lastProcessedAt: Date | null;
}

export interface CuratedSearchResult {
  periodDays: number;
  /** Calendar dates ("YYYY-MM-DD") in the configured timezone — see curated-date.util.ts. */
  dateFrom: string;
  dateTo: string;
  total: number;
  bySentiment: Record<Sentiment, number>;
  /** Curated mentions with no publishedAt at all — never inside any period window, counted here instead. */
  undatedCount: number;
  pool: PoolStats;
  /**
   * How many pool links this very call actually fetched, dated and classified before reading
   * (the CURATED_LAZY_PROCESS top-up pass, see lazyProcess). 0 when the pass is off or found
   * nothing left to do. Reported to the user by the bot so the work it just did is visible
   * rather than looking like an unexplained pause.
   */
  processedNow: number;
}

export interface CuratedMentionView {
  id: string;
  title: string;
  sourceLabel: string;
  publishedAt: Date | null;
  sentiment: Sentiment;
  /** Pre-truncated (~250 chars) LLM summary, or null when the mention has none yet. */
  summary: string | null;
  /** Pre-truncated (~200 chars) fallback built from the raw text — the message formatter uses
   *  this only when `summary` is null. */
  snippet: string | null;
}

/**
 * Read-only view over the closed pool of pre-vetted links (`curated_links` + the `mentions` rows
 * they produced) — the only thing /search and /status touch. Never queries any collector, never
 * does network I/O; every method here is a DB read. Never selects `mentions.url`/`mentions.reprints`
 * — those columns must never reach a Telegram message (see README "Приватность").
 *
 * Extended by ПРОМПТ 2's ingestion script (which owns writing to `curated_links`/inserting the
 * mentions themselves) — this service's public method signatures are a contract for that script's
 * callers too, so avoid changing them without a reason that touches both prompts.
 */
@Injectable()
export class CuratedSearchService {
  private readonly logger = new Logger(CuratedSearchService.name);

  constructor(
    @InjectRepository(Mention)
    private readonly mentionsRepo: Repository<Mention>,
    @InjectRepository(CuratedLink)
    private readonly curatedLinksRepo: Repository<CuratedLink>,
    private readonly config: ConfigService,
    private readonly ingestService: CuratedIngestService,
  ) {}

  private get timezone(): string {
    return this.config.get<string>('curated.timezone') || 'Asia/Almaty';
  }

  private dateWindow(periodDays: number, now: Date): { tz: string; dateFrom: string; dateTo: string } {
    const tz = this.timezone;
    const dateTo = zonedDateString(now, tz);
    const dateFrom = subtractCalendarDays(dateTo, periodDays);
    return { tz, dateFrom, dateTo };
  }

  /** Mentions produced by the pool, dated, inside the calendar-day window in the configured timezone. */
  private inWindowQuery(tz: string, dateFrom: string, dateTo: string) {
    return this.mentionsRepo
      .createQueryBuilder('m')
      .where('m.curatedLinkId IS NOT NULL')
      .andWhere('m.publishedAt IS NOT NULL')
      // published_at is timestamptz; casting to ::date only after shifting to `tz` is what makes
      // the boundary a calendar midnight in Asia/Almaty, not UTC — see curated-date.util.ts.
      .andWhere('(m.publishedAt AT TIME ZONE :tz)::date BETWEEN :dateFrom AND :dateTo', { tz, dateFrom, dateTo });
  }

  async search(periodDays: number, now: Date = new Date()): Promise<CuratedSearchResult> {
    const { tz, dateFrom, dateTo } = this.dateWindow(periodDays, now);

    const processedNow = await this.lazyProcess(dateFrom, now);

    const total = await this.inWindowQuery(tz, dateFrom, dateTo).getCount();

    const bySentimentRaw = await this.inWindowQuery(tz, dateFrom, dateTo)
      .select('m.sentiment', 'sentiment')
      .addSelect('COUNT(*)', 'count')
      .groupBy('m.sentiment')
      .getRawMany<{ sentiment: Sentiment; count: string }>();
    const bySentiment = zeroedSentimentRecord();
    for (const row of bySentimentRaw) {
      bySentiment[row.sentiment] = parseInt(row.count, 10);
    }

    const undatedCount = await this.mentionsRepo
      .createQueryBuilder('m')
      .where('m.curatedLinkId IS NOT NULL')
      .andWhere('m.publishedAt IS NULL')
      .getCount();

    const pool = await this.getPoolStats();

    return { periodDays, dateFrom, dateTo, total, bySentiment, undatedCount, pool, processedNow };
  }

  /**
   * One page of dated, in-window curated mentions, `published_at DESC, id ASC`. `offset` counts
   * from the start of the whole (unpaginated) window, matching the running total /search's
   * "Показать ещё" button reports — not from any previous page.
   */
  async findPage(periodDays: number, offset: number, limit: number, now: Date = new Date()): Promise<CuratedMentionView[]> {
    const { tz, dateFrom, dateTo } = this.dateWindow(periodDays, now);

    const rows = await this.inWindowQuery(tz, dateFrom, dateTo)
      .select(['m.id', 'm.title', 'm.sourceLabel', 'm.publishedAt', 'm.sentiment', 'm.summary', 'm.text'])
      .orderBy('m.publishedAt', 'DESC')
      .addOrderBy('m.id', 'ASC')
      .offset(offset)
      .limit(Math.min(limit, PAGE_FETCH_LIMIT))
      .getMany();

    return rows.map((m) => ({
      id: m.id,
      title: m.title,
      sourceLabel: m.sourceLabel ?? CURATED_DEFAULT_SOURCE_LABEL,
      publishedAt: m.publishedAt,
      sentiment: m.sentiment,
      summary: m.summary ? truncateText(m.summary, SUMMARY_DISPLAY_LENGTH) : null,
      snippet: m.text ? truncateText(m.text, SNIPPET_DISPLAY_LENGTH) : null,
    }));
  }

  /**
   * Optional top-up pass (CURATED_LAZY_PROCESS=true) run before the DB read: takes up to
   * CURATED_LAZY_MAX_LINKS still-unprocessed links and processes them inside a
   * CURATED_LAZY_BUDGET_MS budget, so a pool that was only partly filled keeps catching up
   * through ordinary bot usage instead of waiting for someone to run the script.
   *
   * Three things keep this safe inside a Telegram handler that must answer in ~30s:
   *  - the budget is a deadline passed down to the ingest service, which starts no new link past
   *    it (a link already in flight finishes — its own CURATED_LINK_TIMEOUT_MS bounds it);
   *  - links whose date is already visible IN THE URL and older than the requested period are
   *    skipped this time round: they cannot appear in these results however they classify, so
   *    spending the budget (and an OpenAI call) on them now helps nobody;
   *  - any failure here is swallowed. The point of the command is to READ the pool; a failing
   *    top-up must never turn a working /search into an error message.
   */
  private async lazyProcess(dateFrom: string, now: Date): Promise<number> {
    if (this.config.get<boolean>('curated.lazyProcess') !== true) {
      return 0;
    }

    const maxLinks = this.config.get<number>('curated.lazyMaxLinks') ?? 10;
    const budgetMs = this.config.get<number>('curated.lazyBudgetMs') ?? 20000;
    const deadline = Date.now() + budgetMs;

    try {
      const candidates = await this.ingestService.findLazyCandidates(maxLinks * 3);
      const windowStart = new Date(`${dateFrom}T00:00:00Z`);

      const worthDoingNow = candidates
        .filter((link) => {
          const urlDate = extractDateFromUrl(link.url, now);
          return !urlDate || urlDate >= windowStart;
        })
        .slice(0, maxLinks);

      if (worthDoingNow.length === 0) {
        return 0;
      }

      const context = await this.ingestService.buildContext();
      let processed = 0;
      for (const link of worthDoingNow) {
        if (Date.now() >= deadline) {
          this.logger.log(`Ленивая дообработка: бюджет ${budgetMs} мс исчерпан, новые ссылки не начинаю`);
          break;
        }
        await this.ingestService.processLink(link, context);
        processed += 1;
      }
      return processed;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Ленивая дообработка пропущена (чтение из БД не затронуто): ${message}`);
      // Whatever was already processed before the failure stays processed, but the count is no
      // longer trustworthy here — report nothing rather than a number that may undercount.
      return 0;
    }
  }

  async getPoolStats(): Promise<PoolStats> {
    const totalLinks = await this.curatedLinksRepo.count();

    const byStatusRaw = await this.curatedLinksRepo
      .createQueryBuilder('c')
      .select('c.status', 'status')
      .addSelect('COUNT(*)', 'count')
      .groupBy('c.status')
      .getRawMany<{ status: CuratedLinkStatus; count: string }>();
    const byStatus = zeroedStatusRecord();
    for (const row of byStatusRaw) {
      byStatus[row.status] = parseInt(row.count, 10);
    }

    const mentionsTotal = await this.mentionsRepo.createQueryBuilder('m').where('m.curatedLinkId IS NOT NULL').getCount();

    const undatedMentions = await this.mentionsRepo
      .createQueryBuilder('m')
      .where('m.curatedLinkId IS NOT NULL')
      .andWhere('m.publishedAt IS NULL')
      .getCount();

    const dateRange = await this.mentionsRepo
      .createQueryBuilder('m')
      .select('MIN(m.publishedAt)', 'first')
      .addSelect('MAX(m.publishedAt)', 'last')
      .where('m.curatedLinkId IS NOT NULL')
      .andWhere('m.publishedAt IS NOT NULL')
      .getRawOne<{ first: Date | null; last: Date | null }>();

    const lastProcessed = await this.curatedLinksRepo
      .createQueryBuilder('c')
      .select('MAX(c.processedAt)', 'lastProcessedAt')
      .getRawOne<{ lastProcessedAt: Date | null }>();

    return {
      totalLinks,
      byStatus,
      mentionsTotal,
      undatedMentions,
      firstArticleDate: dateRange?.first ?? null,
      lastArticleDate: dateRange?.last ?? null,
      lastProcessedAt: lastProcessed?.lastProcessedAt ?? null,
    };
  }
}

function zeroedSentimentRecord(): Record<Sentiment, number> {
  return Object.values(Sentiment).reduce((acc, s) => ({ ...acc, [s]: 0 }), {} as Record<Sentiment, number>);
}

function zeroedStatusRecord(): Record<CuratedLinkStatus, number> {
  return Object.values(CuratedLinkStatus).reduce((acc, s) => ({ ...acc, [s]: 0 }), {} as Record<CuratedLinkStatus, number>);
}
