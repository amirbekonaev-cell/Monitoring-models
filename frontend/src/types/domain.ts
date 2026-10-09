export type Sentiment = 'positive' | 'negative' | 'neutral' | 'undefined';

export type MentionSourceType = 'news' | 'social' | 'telegram' | 'reviews' | 'other' | 'social_search';

export interface Mention {
  id: string;
  title: string;
  text: string;
  /**
   * null for a mention whose source link is deliberately withheld (the closed link pool) — the
   * backend strips it before the response is serialized, so it is genuinely absent rather than
   * hidden in the UI. See backend mention-privacy.util.ts; MentionCard renders such a mention's
   * title as plain text.
   */
  url: string | null;
  publishedAt: string | null;
  foundAt: string;
  sourceId: string | null;
  sourceType: MentionSourceType;
  sourceLabel: string | null;
  language: string | null;
  sentiment: Sentiment;
  sentimentManual: boolean;
  summary: string | null;
}

export interface MentionsResponse {
  items: Mention[];
  total: number;
  limit: number;
  offset: number;
}

// Matches the backend's PERIOD_DAYS (mentions.controller.ts) and the Telegram bot's /search
// period picker (curated/search-period.util.ts) — the three must stay in step, or the same
// "год"/"2 года" means a different date range depending on where you clicked it.
export type PeriodPreset = 'today' | '7d' | '30d' | '60d' | '90d' | '180d' | '365d' | '730d' | 'custom';

/** Filter state shared by the feed and the dashboard's compact period picker. */
export interface MentionsFilters {
  period: PeriodPreset;
  dateFrom?: string;
  dateTo?: string;
  sentiment?: Sentiment;
  sourceId?: string;
  sourceType?: MentionSourceType;
  language?: string;
  search?: string;
}

export interface MentionsStats {
  total: number;
  previousTotal: number;
  changePercent: number | null;
  byDay: { date: string; count: number }[];
  bySentiment: Record<Sentiment, number>;
  topSources: { sourceId: string | null; name: string | null; count: number }[];
}

export type SourceKind = 'rss' | 'telegram' | 'parser' | 'search_api' | 'social_api' | 'social_search_api' | 'curated';
export type SourceStatus = 'active' | 'error' | 'disabled';

export interface Source {
  id: string;
  name: string | null;
  url: string;
  type: SourceKind;
  status: SourceStatus;
  lastSuccessAt: string | null;
  lastError: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  mentionsCount: number;
}

export interface AddSourceResponse {
  source: Source;
  type: Source['type'];
  ok: boolean;
  message: string;
  itemsFound?: number;
  itemsNew?: number;
  itemsFilteredByKeywords?: number;
  deepScanNote?: string;
}

export type KeywordType = 'required' | 'minus' | 'exact_phrase';

export interface Keyword {
  id: string;
  phrase: string;
  type: KeywordType;
  isActive: boolean;
  language: string;
  manualForms: string[];
  createdAt: string;
}
