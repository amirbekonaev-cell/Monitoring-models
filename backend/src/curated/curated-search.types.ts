import { Sentiment } from '../mentions/mention.entity';
import { CuratedLinkStatus } from './curated-link.entity';
import { CuratedStatus } from './curated-mentions';

export const CURATED_DEFAULT_SOURCE_LABEL = 'Подборка материалов';

/**
 * Statistics about the in-memory card set (curated-mentions.data.json) rather than the DB pool of
 * links. Present only on PoolStats produced by CuratedJsonSearchService — the DB-backed
 * CuratedSearchService leaves it undefined, which is what the /status and empty-period formatters
 * branch on. Without it they would have to describe a set of hand-written cards in the vocabulary
 * of a processing queue ("в очереди 0", "последняя обработка ещё не запускалась"), which is
 * meaningless for data that is never processed at all.
 */
export interface CardSetStats {
  /** Every card in the JSON file, duplicates included. */
  total: number;
  /** Cards /search can actually show — total minus duplicates. */
  shown: number;
  /** Cards marked `status: 'duplicate'`, hidden from /search (see CuratedJsonSearchService). */
  duplicates: number;
  /** Shown cards per hand-assigned verification status (verified/partial/unverified). */
  byStatus: Record<CuratedStatus, number>;
  /** Shown cards per sentiment, over the whole set (not one period). */
  bySentiment: Record<Sentiment, number>;
}

export interface PoolStats {
  totalLinks: number;
  byStatus: Record<CuratedLinkStatus, number>;
  mentionsTotal: number;
  undatedMentions: number;
  firstArticleDate: Date | null;
  lastArticleDate: Date | null;
  lastProcessedAt: Date | null;
  /** Set only by the JSON source — see CardSetStats. */
  cards?: CardSetStats;
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
}

export interface CuratedMentionView {
  id: string;
  title: string;
  sourceLabel: string;
  publishedAt: Date | null;
  sentiment: Sentiment;
  /** Ready-to-send summary, or null when the mention has none. */
  summary: string | null;
  /** Pre-truncated (~200 chars) fallback built from the raw text — the message formatter uses
   *  this only when `summary` is null. */
  snippet: string | null;
}

/**
 * What /search and /status need, independent of where the data lives. Two implementations:
 *  - CuratedJsonSearchService — the in-memory card set (curated-mentions.data.json). This is what
 *    the Telegram bot is wired to: no DB, no network, no OpenAI, answers in microseconds.
 *  - CuratedSearchService — the `curated_links` + `mentions` DB pool. Kept as the fallback for the
 *    CLI scripts (npm run curated:status, curated:leak-check) which exist to inspect that pool.
 *
 * Nothing behind this interface may do network I/O or call an LLM: a Telegram handler has ~30s and
 * must not depend on a third-party API being up (or on OPENAI_API_KEY being set at all).
 */
export interface CuratedSearchSource {
  search(periodDays: number, now?: Date): Promise<CuratedSearchResult>;
  findPage(periodDays: number, offset: number, limit: number, now?: Date): Promise<CuratedMentionView[]>;
  getPoolStats(): Promise<PoolStats>;
}

/** DI token for CuratedSearchSource — see CuratedMentionsModule for what is bound to it. */
export const CURATED_SEARCH_SOURCE = 'CURATED_SEARCH_SOURCE';

export function zeroedSentimentRecord(): Record<Sentiment, number> {
  return Object.values(Sentiment).reduce((acc, s) => ({ ...acc, [s]: 0 }), {} as Record<Sentiment, number>);
}

export function zeroedLinkStatusRecord(): Record<CuratedLinkStatus, number> {
  return Object.values(CuratedLinkStatus).reduce((acc, s) => ({ ...acc, [s]: 0 }), {} as Record<CuratedLinkStatus, number>);
}
