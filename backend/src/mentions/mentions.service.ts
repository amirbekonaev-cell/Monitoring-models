import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash, randomUUID } from 'crypto';
import { DataSource, Repository, SelectQueryBuilder } from 'typeorm';
import { Mention, MentionSourceType, Sentiment } from './mention.entity';
import { Source } from '../sources/source.entity';
import {
  SentimentAnalysisService,
  SentimentClassification,
  SentimentClassifyOptions,
} from '../sentiment/sentiment-analysis.service';

export interface CreateMentionInput {
  title: string;
  text: string;
  url: string;
  publishedAt: Date | null;
  sourceId: string;
  sourceType: Mention['sourceType'];
  /** See Mention.sourceLabel — explicit per-item source/domain when a channel can return results from more than one platform per call. */
  sourceLabel?: string | null;
  hash: string;
  keywords: string[];
  /**
   * True when this item came from a source's one-time historical catch-up run. Backfilled
   * items are inserted already marked as notified (notificationSent=true) so they never queue
   * a Telegram alert and don't arrive as a spam burst — only genuinely new post-backfill items do.
   */
  isBackfill?: boolean;
  /**
   * Disables BOTH the exact-hash duplicate check and the pg_trgm similarity ("reprint") check
   * for this insert. Only the consolidated OpenAI web search channel (К-6) sets this: unlike
   * sites/RSS/parser, where the same news story genuinely gets reprinted verbatim by several
   * outlets and should collapse into one card, every web-search result is its own independent
   * finding (a different page, a different quote) even when the wording looks similar — it
   * should always show up as its own entry, every time it's found, not get merged away.
   */
  skipDedup?: boolean;
  /**
   * Closed-pool insert (ПРОМПТ 2): marks the mention's URL as never-show and ties it back to the
   * `curated_links` row that produced it. `urlHidden` is stored as its own durable column rather
   * than being derived from `curatedLinkId` — see Mention.urlHidden.
   */
  urlHidden?: boolean;
  curatedLinkId?: string | null;
  /**
   * Per-call overrides for the tone prompt, passed straight through to
   * SentimentAnalysisService.classify. Only the closed-pool ingest sets it (see
   * CuratedIngestService); omitted everywhere else, which keeps the shared prompt — and therefore
   * every other channel's summaries — exactly as it was. There is still only ONE classifier and
   * one prompt; this is a parameter of it, not a second copy.
   */
  sentimentOptions?: SentimentClassifyOptions;
}

/** Filters shared by the feed list and the dashboard stats aggregation — kept in one place so
 *  neither reimplements the WHERE clause. `dateFrom`/`dateTo` compare against
 *  COALESCE(published_at, found_at): some collectors never learn a publish date, and falling
 *  back to when we found the item keeps those mentions filterable instead of invisible. */
export interface MentionFilters {
  sentiment?: Sentiment;
  sourceId?: string;
  sourceType?: MentionSourceType;
  language?: string;
  search?: string;
  dateFrom?: Date;
  dateTo?: Date;
}

export interface FindMentionsQuery extends MentionFilters {
  limit: number;
  offset: number;
}

export interface MentionsStatsQuery extends MentionFilters {
  dateFrom: Date;
  dateTo: Date;
}

export interface MentionsStats {
  total: number;
  previousTotal: number;
  /** null when there's nothing in the previous period to compare against (division by zero). */
  changePercent: number | null;
  byDay: { date: string; count: number }[];
  bySentiment: Record<Sentiment, number>;
  topSources: { sourceId: string | null; name: string | null; count: number }[];
}

/**
 * Both title AND body text must be at or above these trigram similarity levels to be treated
 * as the same story reprinted elsewhere. Title-only matching turned out to be too aggressive
 * in practice: recurring template columns ("Какая погода будет в Казахстане 18 августа" vs
 * "...19 августа", daily military-briefing digests, "what holiday is today") share near-
 * identical titles day to day while being genuinely different articles with different body
 * text — title-only similarity silently swallowed them as fake reprints. Real reprints/copies
 * carry over the article body close to verbatim, so requiring text similarity too tells the
 * two cases apart.
 */
const REPRINT_TITLE_SIMILARITY_THRESHOLD = 0.6;
const REPRINT_TEXT_SIMILARITY_THRESHOLD = 0.5;

/**
 * Attempts (including the first) for a classification that keeps failing *transiently* — see
 * classifyWithRetries. Three is deliberately small: the caller is either a Telegram handler with
 * ~30s to answer or a bulk script that will revisit the mention anyway.
 */
const SENTIMENT_CLASSIFY_ATTEMPTS = 3;
const SENTIMENT_RETRY_BASE_DELAY_MS = 800;

export type CreateMentionResult = 'inserted' | 'reprint' | 'duplicate';

export interface CreateMentionAndClassifyResult {
  result: CreateMentionResult;
  sentiment: Sentiment;
}

@Injectable()
export class MentionsService {
  private readonly logger = new Logger(MentionsService.name);

  constructor(
    @InjectRepository(Mention)
    private readonly mentionsRepo: Repository<Mention>,
    private readonly dataSource: DataSource,
    private readonly sentimentAnalysisService?: SentimentAnalysisService,
  ) {}

  /**
   * Inserts a mention if it's genuinely new. If it's an exact hash duplicate or a
   * near-duplicate title (pg_trgm similarity) of an existing mention, records it as a
   * reprint on the existing card instead of creating a new row.
   */
  async createIfNew(input: CreateMentionInput): Promise<CreateMentionResult> {
    const { result, id } = await this.insertOrDedup(input);

    if (result === 'inserted' && id) {
      // Fire-and-forget, deliberately not awaited: a slow/failing OpenAI call must never delay the
      // insert or its caller (RSS/Parser/Telegram/VK ingestion, or the onboarding "add by link"
      // test collection). There's no queue/retry behind this any more — a failure is logged once
      // and the mention stays at Sentiment.UNDEFINED (same permanent-error outcome
      // SentimentAnalysisService already returns for a missing key or a bad response), rather than
      // being retried later.
      void this.classifySentimentInBackground(id);
    }

    return result;
  }

  /**
   * Same insert/dedup logic as createIfNew, but waits for sentiment classification instead of
   * firing it in the background — for a caller that wants the real tone back immediately rather
   * than "не определена" until a later fire-and-forget classification lands (the closed-pool
   * ingestion script is the current caller; every other ingestion path keeps using the
   * fire-and-forget createIfNew() above, untouched). Safe only when the caller already tolerates
   * the extra classification latency.
   */
  async createIfNewAndClassify(input: CreateMentionInput): Promise<CreateMentionAndClassifyResult> {
    const { result, id } = await this.insertOrDedup(input);

    if (!id) {
      return { result, sentiment: Sentiment.UNDEFINED };
    }

    if (result === 'inserted') {
      await this.classifySentimentInBackground(id, input.sentimentOptions);
    }

    // For an already-known mention (duplicate/reprint), just read back whatever sentiment it
    // already has rather than reclassifying it — findById() by the existing row's id, not by
    // anything derived from `input`.
    const mention = await this.findById(id);
    return { result, sentiment: mention?.sentiment ?? Sentiment.UNDEFINED };
  }

  private async insertOrDedup(input: CreateMentionInput): Promise<{ result: CreateMentionResult; id: string }> {
    const isBackfill = input.isBackfill ?? false;

    if (!input.skipDedup) {
      // `url_hidden = false` on both dedup checks: a pool mention must never be found as the
      // "existing" row an ordinary insert collapses into. If it were, addReprintIfNewUrl() would
      // append the ordinary (public) URL to a hidden mention — or, the other way round, a later
      // public duplicate would adopt the hidden row and the hidden URL would be served as that
      // public mention's own. Pool rows are inserted with skipDedup: true, so they never run
      // these checks themselves; this filter closes the same hole from the other side.
      const existingByHash = await this.mentionsRepo.findOne({ where: { hash: input.hash, urlHidden: false } });
      if (existingByHash) {
        await this.addReprintIfNewUrl(existingByHash, input);
        return { result: 'duplicate', id: existingByHash.id };
      }

      const similar = await this.findSimilarByContent(input.title, input.text, input.publishedAt);
      if (similar) {
        await this.addReprintIfNewUrl(similar, input);
        return { result: 'reprint', id: similar.id };
      }
    }

    // hash has a UNIQUE constraint AND a varchar(64) length limit at the DB level regardless of
    // skipDedup — a skipDedup insert still needs a hash that (a) won't collide with an earlier
    // row for the same (or similar) finding, since we deliberately skipped the checks that would
    // normally catch that, and (b) fits the column. input.hash is already a 64-char sha256 hex
    // digest, so naively appending a random suffix overflows varchar(64) — re-hashing it together
    // with a fresh random component keeps it at exactly 64 hex characters.
    const hash = input.skipDedup
      ? createHash('sha256').update(`${input.hash}:${randomUUID()}`).digest('hex')
      : input.hash;

    const result = await this.mentionsRepo
      .createQueryBuilder()
      .insert()
      .into(Mention)
      .values({
        title: input.title,
        text: input.text,
        url: input.url,
        publishedAt: input.publishedAt,
        sourceId: input.sourceId,
        sourceType: input.sourceType,
        sourceLabel: input.sourceLabel ?? null,
        hash,
        keywords: input.keywords,
        reprints: [],
        isBackfill,
        urlHidden: input.urlHidden ?? false,
        curatedLinkId: input.curatedLinkId ?? null,
        // No background collection writes mentions any more (see README "Деплой на Vercel") —
        // there is no per-mention Telegram alert left to guard against, but the column still
        // records whether a mention came from a backfill run.
        notificationSent: isBackfill,
      })
      .orIgnore()
      .execute();

    const insertedId = result.identifiers?.[0]?.id as string | undefined;
    if (!insertedId) {
      return { result: 'duplicate', id: '' };
    }

    return { result: 'inserted', id: insertedId };
  }

  /**
   * Classifies an existing mention now, awaited. Same work classifySentimentInBackground() does,
   * exposed for a caller that is re-processing a row which never received a tone (see
   * CuratedIngestService's --force path) and wants the result before it reports.
   */
  async classifyExisting(mentionId: string, options?: SentimentClassifyOptions): Promise<void> {
    await this.classifySentimentInBackground(mentionId, options);
  }

  private async classifySentimentInBackground(mentionId: string, options?: SentimentClassifyOptions): Promise<void> {
    if (!this.sentimentAnalysisService) {
      return;
    }
    try {
      const mention = await this.findById(mentionId);
      if (!mention) {
        return;
      }
      // classify() throws only on genuinely transient failures (network/timeout, HTTP 429, 5xx —
      // see SentimentAnalysisService) and returns null on permanent ones. A single 429 used to be
      // enough to leave a mention "не определена" forever, since nothing ever retried it: that is
      // how most of the pool ended up unclassified. Retrying only the transient case keeps a
      // rate-limit blip from costing a tone, without hammering the API on a bad key or a request
      // it will reject identically every time.
      // No url for a pool mention: SentimentAnalysisService uses it to re-download the article
      // when the stored text looks like a teaser, which would (a) undo the context extraction
      // that put the company mention in front of the classifier in the first place (see
      // curated-context.util.ts) and (b) spend a second HTTP request on a page already read.
      const classification = await this.classifyWithRetries(
        mention.title,
        mention.text,
        mention.urlHidden ? null : mention.url,
        mentionId,
        options,
      );
      if (!classification) {
        return;
      }
      await this.updateSentiment(mentionId, classification.sentiment, classification.summary);
      this.logger.log(`Mention ${mentionId} sentiment classified as "${classification.sentiment}": ${classification.reason}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Не удалось определить тональность упоминания ${mentionId}: ${message}`);
    }
  }

  /**
   * Retries a *transient* classification failure a couple of times with a short backoff. Never
   * invents a tone: if every attempt fails the mention keeps Sentiment.UNDEFINED and says so in
   * the log — a made-up "нейтрал" would be worse than an honest "не определена", because it is
   * indistinguishable from a real classification once it's in the database.
   */
  private async classifyWithRetries(
    title: string,
    text: string,
    url: string | null,
    mentionId: string,
    options?: SentimentClassifyOptions,
  ): Promise<SentimentClassification | null> {
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= SENTIMENT_CLASSIFY_ATTEMPTS; attempt += 1) {
      try {
        // `options` is omitted rather than passed as `undefined` when the caller customized
        // nothing, so the five non-pool channels issue the exact same call they always did.
        return await (options
          ? this.sentimentAnalysisService!.classify(title, text, url, options)
          : this.sentimentAnalysisService!.classify(title, text, url));
      } catch (error) {
        lastError = error;
        if (attempt < SENTIMENT_CLASSIFY_ATTEMPTS) {
          const delayMs = SENTIMENT_RETRY_BASE_DELAY_MS * attempt;
          this.logger.warn(
            `Тональность упоминания ${mentionId}: попытка ${attempt}/${SENTIMENT_CLASSIFY_ATTEMPTS} не удалась ` +
              `(${error instanceof Error ? error.message : String(error)}) — повтор через ${delayMs} мс`,
          );
          await sleep(delayMs);
        }
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  /**
   * Refreshes the content of a mention produced by the closed pool, for a re-run of an already
   * processed link (`curated:process --force`). Needed because those rows are inserted with
   * `skipDedup`, and a partial UNIQUE index on `curated_link_id` means a second insert for the
   * same link is silently ignored — so without this, re-reading a page (e.g. after fixing how
   * its publish date is extracted) would leave the stored mention exactly as it was.
   *
   * Deliberately does NOT touch `sentiment`/`sentiment_manual`: re-reading a page is not a
   * reason to discard a human's tone correction (ФТ-11), and the caller re-classifies
   * separately when it decides that is warranted.
   */
  async updateCuratedContent(
    id: string,
    content: { title: string; text: string; publishedAt: Date | null; sourceLabel: string | null; keywords: string[] },
  ): Promise<void> {
    await this.mentionsRepo
      .createQueryBuilder()
      .update(Mention)
      .set({
        title: content.title,
        text: content.text,
        publishedAt: content.publishedAt,
        sourceLabel: content.sourceLabel,
        keywords: content.keywords,
      })
      .where('id = :id AND url_hidden = true', { id })
      .execute();
  }

  findById(id: string): Promise<Mention | null> {
    return this.mentionsRepo.findOne({ where: { id } });
  }

  /**
   * Atomically flips notification_sent false->true and reports whether *this* call was the
   * one that made the change. This claim-before-send pattern is what guarantees "one mention,
   * one notification" even across a crash/restart: if the worker dies after the claim succeeds
   * but before the Telegram API call completes, the mention is left marked as sent without ever
   * having been delivered (a rare silent miss) rather than risking a duplicate send on retry —
   * the trade-off explicitly asked for here. A failed send calls markNotificationFailed to
   * release the claim so a later retry can actually go through. Currently unused (no per-mention
   * Telegram sender exists any more — see README "Деплой на Vercel"), kept in case a notification
   * path is reintroduced.
   */
  async claimForNotification(id: string): Promise<boolean> {
    const result = await this.mentionsRepo
      .createQueryBuilder()
      .update(Mention)
      .set({ notificationSent: true })
      .where('id = :id AND notification_sent = false', { id })
      .execute();
    return (result.affected ?? 0) > 0;
  }

  async markNotificationFailed(id: string): Promise<void> {
    await this.mentionsRepo.update(id, { notificationSent: false });
  }

  /**
   * Machine classification write-back. Guarded by `WHERE sentiment_manual = false` at the DB
   * level: if a human already edited this mention's sentiment (ФТ-11) between the classify job
   * being queued and it finishing (e.g. a slow OpenAI response racing a manual edit), this no-ops
   * instead of clobbering the human's choice — a manual edit must never be silently overwritten
   * by a later automatic re-classification, regardless of timing.
   */
  async updateSentiment(id: string, sentiment: Sentiment, summary?: string | null): Promise<void> {
    await this.mentionsRepo
      .createQueryBuilder()
      .update(Mention)
      .set({ sentiment, sentimentManual: false, ...(summary !== undefined ? { summary } : {}) })
      .where('id = :id AND sentiment_manual = false', { id })
      .execute();
  }

  /** Human edit (ФТ-11) — always wins, and marks the mention so future auto-classification skips it. */
  async updateSentimentManually(id: string, sentiment: Sentiment): Promise<Mention | null> {
    const result = await this.mentionsRepo
      .createQueryBuilder()
      .update(Mention)
      .set({ sentiment, sentimentManual: true })
      .where('id = :id', { id })
      .execute();
    if (!result.affected) {
      return null;
    }
    return this.findById(id);
  }

  private async findSimilarByContent(title: string, text: string, publishedAt: Date | null): Promise<Mention | null> {
    // Window the comparison to nearby publish dates so we don't chase similarity across
    // the whole table, and so two unrelated stories that happen to share generic wording
    // months apart don't get merged.
    const windowStart = publishedAt ? new Date(publishedAt.getTime() - 5 * 24 * 60 * 60 * 1000) : null;
    const windowEnd = publishedAt ? new Date(publishedAt.getTime() + 5 * 24 * 60 * 60 * 1000) : null;

    // No body text to compare (some channels only surface a title) — fall back to a much
    // stricter title-only bar so a bare-title item still can't casually match a template.
    if (!text.trim()) {
      const rows = await this.dataSource.query(
        `SELECT id FROM mentions
         WHERE similarity(title, $1) > 0.9
           AND url_hidden = false
           AND ($2::timestamptz IS NULL OR published_at IS NULL OR published_at BETWEEN $2 AND $3)
         ORDER BY similarity(title, $1) DESC
         LIMIT 1`,
        [title, windowStart, windowEnd],
      );
      return rows.length > 0 ? this.mentionsRepo.findOne({ where: { id: rows[0].id } }) : null;
    }

    const rows = await this.dataSource.query(
      `SELECT id, similarity(title, $1) as title_sim, similarity(text, $2) as text_sim
       FROM mentions
       WHERE similarity(title, $1) > $3
         AND url_hidden = false
         AND similarity(text, $2) > $4
         AND ($5::timestamptz IS NULL OR published_at IS NULL OR published_at BETWEEN $5 AND $6)
       ORDER BY (similarity(title, $1) + similarity(text, $2)) DESC
       LIMIT 1`,
      [
        title,
        text,
        REPRINT_TITLE_SIMILARITY_THRESHOLD,
        REPRINT_TEXT_SIMILARITY_THRESHOLD,
        windowStart,
        windowEnd,
      ],
    );

    if (rows.length === 0) {
      return null;
    }
    return this.mentionsRepo.findOne({ where: { id: rows[0].id } });
  }

  private async addReprintIfNewUrl(existing: Mention, input: CreateMentionInput): Promise<void> {
    if (existing.url === input.url) {
      return;
    }
    const alreadyRecorded = existing.reprints?.some((r) => r.url === input.url);
    if (alreadyRecorded) {
      return;
    }
    const reprints = [
      ...(existing.reprints ?? []),
      { url: input.url, sourceId: input.sourceId, foundAt: new Date().toISOString() },
    ];
    await this.mentionsRepo.update(existing.id, { reprints });
    this.logger.log(`Reprint recorded on mention ${existing.id}: ${input.url}`);
  }

  private applyFilters(qb: SelectQueryBuilder<Mention>, filters: MentionFilters): void {
    if (filters.sentiment) {
      qb.andWhere('m.sentiment = :sentiment', { sentiment: filters.sentiment });
    }
    if (filters.sourceId) {
      qb.andWhere('m.sourceId = :sourceId', { sourceId: filters.sourceId });
    }
    if (filters.sourceType) {
      qb.andWhere('m.sourceType = :sourceType', { sourceType: filters.sourceType });
    }
    if (filters.language) {
      qb.andWhere('m.language = :language', { language: filters.language });
    }
    if (filters.search) {
      qb.andWhere('(m.title ILIKE :search OR m.text ILIKE :search)', { search: `%${filters.search}%` });
    }
    if (filters.dateFrom) {
      qb.andWhere('COALESCE(m.publishedAt, m.foundAt) >= :dateFrom', { dateFrom: filters.dateFrom });
    }
    if (filters.dateTo) {
      qb.andWhere('COALESCE(m.publishedAt, m.foundAt) <= :dateTo', { dateTo: filters.dateTo });
    }
  }

  async findRecent(query: FindMentionsQuery): Promise<{ items: Mention[]; total: number }> {
    const qb = this.mentionsRepo
      .createQueryBuilder('m')
      .orderBy('m.publishedAt', 'DESC')
      .addOrderBy('m.foundAt', 'DESC')
      .take(query.limit)
      .skip(query.offset);
    this.applyFilters(qb, query);
    const [items, total] = await qb.getManyAndCount();
    return { items, total };
  }

  async countBySource(sourceId: string): Promise<number> {
    return this.mentionsRepo.count({ where: { sourceId } });
  }

  /**
   * Dashboard aggregation: total + % change vs. the immediately preceding period of the same
   * length, a per-day count series, a sentiment breakdown, and the top 10 sources — all under
   * the same filters as findRecent, so the dashboard and the feed never disagree about what
   * "matches the current filters" means.
   */
  async getStats(query: MentionsStatsQuery): Promise<MentionsStats> {
    const durationMs = query.dateTo.getTime() - query.dateFrom.getTime();
    const previous: MentionFilters = {
      ...query,
      dateFrom: new Date(query.dateFrom.getTime() - durationMs - 1),
      dateTo: new Date(query.dateFrom.getTime() - 1),
    };

    const totalQb = this.mentionsRepo.createQueryBuilder('m');
    this.applyFilters(totalQb, query);
    const total = await totalQb.getCount();

    const previousQb = this.mentionsRepo.createQueryBuilder('m');
    this.applyFilters(previousQb, previous);
    const previousTotal = await previousQb.getCount();

    const changePercent = previousTotal === 0 ? null : Math.round(((total - previousTotal) / previousTotal) * 1000) / 10;

    const byDayQb = this.mentionsRepo
      .createQueryBuilder('m')
      .select('DATE(COALESCE(m.publishedAt, m.foundAt))::text', 'date')
      .addSelect('COUNT(*)', 'count')
      .groupBy('date')
      .orderBy('date', 'ASC');
    this.applyFilters(byDayQb, query);
    const byDayRaw = await byDayQb.getRawMany<{ date: string; count: string }>();
    const byDay = byDayRaw.map((row) => ({ date: row.date, count: parseInt(row.count, 10) }));

    const bySentimentQb = this.mentionsRepo
      .createQueryBuilder('m')
      .select('m.sentiment', 'sentiment')
      .addSelect('COUNT(*)', 'count')
      .groupBy('m.sentiment');
    this.applyFilters(bySentimentQb, query);
    const bySentimentRaw = await bySentimentQb.getRawMany<{ sentiment: Sentiment; count: string }>();
    const bySentiment = Object.values(Sentiment).reduce(
      (acc, sentiment) => ({ ...acc, [sentiment]: 0 }),
      {} as Record<Sentiment, number>,
    );
    for (const row of bySentimentRaw) {
      bySentiment[row.sentiment] = parseInt(row.count, 10);
    }

    // Подпись источника — имя записи в `sources`, а если её нет, то `source_label` самого
    // упоминания. Второе нужно каналам, у которых записи-источника и не должно быть: выдача
    // Telegram-бота, которую DashboardPublishService кладёт в ленту, подписана изданием
    // ("SK News", "Profit.kz") именно так, и без этого COALESCE весь дашборд показывал бы одну
    // строку «Без источника». Группировка при этом по-прежнему включает source_id, поэтому для
    // обычных упоминаний (sourceLabel = null) разбивка не изменилась.
    const topSourcesQb = this.mentionsRepo
      .createQueryBuilder('m')
      .leftJoin(Source, 's', 's.id = m.sourceId')
      .select('m.sourceId', 'sourceId')
      .addSelect('COALESCE(s.name, m.source_label)', 'name')
      .addSelect('COUNT(*)', 'count')
      .groupBy('m.sourceId')
      .addGroupBy('s.name')
      .addGroupBy('m.source_label')
      .orderBy('count', 'DESC')
      .limit(10);
    this.applyFilters(topSourcesQb, query);
    const topSourcesRaw = await topSourcesQb.getRawMany<{ sourceId: string | null; name: string | null; count: string }>();
    const topSources = topSourcesRaw.map((row) => ({
      sourceId: row.sourceId,
      name: row.name,
      count: parseInt(row.count, 10),
    }));

    return { total, previousTotal, changePercent, byDay, bySentiment, topSources };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    // Classification runs fire-and-forget from createIfNew(), so a pending retry timer must not be
    // what keeps a short-lived process alive — a CLI script (curated:process) would otherwise hang
    // around after its work is done waiting for a backoff nobody is watching.
    timer.unref?.();
  });
}
