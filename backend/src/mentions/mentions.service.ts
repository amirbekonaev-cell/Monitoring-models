import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash, randomUUID } from 'crypto';
import { DataSource, Repository } from 'typeorm';
import { Mention, Sentiment } from './mention.entity';
import { SentimentAnalysisService } from '../sentiment/sentiment-analysis.service';

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
}

export interface FindMentionsQuery {
  limit: number;
  offset: number;
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
   * Same insert/dedup logic as createIfNew, but for on-demand /search only (see
   * OnDemandSearchService): waits for sentiment classification instead of firing it in the
   * background, so the /search summary can show the real tone right away instead of always
   * "не определена". Safe only because /search callers already tolerate extra latency (the
   * Telegram handler uses Vercel's waitUntil() to stay alive for minutes) — every other ingestion
   * path keeps using the fire-and-forget createIfNew() above, untouched.
   */
  async createIfNewAndClassify(input: CreateMentionInput): Promise<CreateMentionAndClassifyResult> {
    const { result, id } = await this.insertOrDedup(input);

    if (!id) {
      return { result, sentiment: Sentiment.UNDEFINED };
    }

    if (result === 'inserted') {
      await this.classifySentimentInBackground(id);
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
      const existingByHash = await this.mentionsRepo.findOne({ where: { hash: input.hash } });
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

  private async classifySentimentInBackground(mentionId: string): Promise<void> {
    if (!this.sentimentAnalysisService) {
      return;
    }
    try {
      const mention = await this.findById(mentionId);
      if (!mention) {
        return;
      }
      const classification = await this.sentimentAnalysisService.classify(mention.title, mention.text, mention.url);
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

  async findRecent(query: FindMentionsQuery): Promise<{ items: Mention[]; total: number }> {
    const [items, total] = await this.mentionsRepo.findAndCount({
      order: { publishedAt: 'DESC', foundAt: 'DESC' },
      take: query.limit,
      skip: query.offset,
    });
    return { items, total };
  }

  async countBySource(sourceId: string): Promise<number> {
    return this.mentionsRepo.count({ where: { sourceId } });
  }
}