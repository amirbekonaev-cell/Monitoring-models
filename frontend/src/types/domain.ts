export type Sentiment = 'positive' | 'negative' | 'neutral' | 'undefined';

export type MentionSourceType = 'news' | 'social' | 'telegram' | 'reviews' | 'other' | 'social_search';

export interface Mention {
  id: string;
  title: string;
  text: string;
  url: string;
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

export type PeriodPreset = 'today' | '7d' | '30d' | 'custom';

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

export type SourceKind = 'rss' | 'telegram' | 'parser' | 'search_api' | 'social_api' | 'social_search_api';
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
