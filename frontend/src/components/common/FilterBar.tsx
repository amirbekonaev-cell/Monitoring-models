import { useEffect, useState } from 'react';
import { MentionsFilters, MentionSourceType, PeriodPreset, Sentiment, Source } from '../../types/domain';
import { SENTIMENT_LABELS } from '../../styles/theme';
import { LANGUAGE_LABELS, MENTION_SOURCE_TYPE_LABELS } from '../../constants/labels';
import styles from './FilterBar.module.css';

export type FilterField = 'period' | 'sentiment' | 'source' | 'sourceType' | 'language' | 'search';

const ALL_FIELDS: FilterField[] = ['period', 'sentiment', 'source', 'sourceType', 'language', 'search'];

// Labels match the Telegram bot's /search period buttons (searchPeriodLabel in
// curated/search-period.util.ts) — the closed pool's mentions are historical (dates spanning
// years, backfilled all at once), so 'today'/'7d'/'30d' alone used to hide nearly all of it from
// the feed/dashboard by default. See mentions.controller.ts PERIOD_DAYS for the day counts.
const PERIOD_LABELS: Record<PeriodPreset, string> = {
  today: 'Сегодня',
  '7d': '7 дней',
  '30d': '30 дней',
  '60d': '2 месяца',
  '90d': '3 месяца',
  '180d': 'Полгода',
  '365d': 'Год',
  '730d': '2 года',
  custom: 'Свои даты',
};

function toDateInputValue(iso?: string): string {
  if (!iso) return '';
  return iso.slice(0, 10);
}

export function FilterBar({
  filters,
  onChange,
  sources,
  fields = ALL_FIELDS,
}: {
  filters: MentionsFilters;
  onChange: (filters: MentionsFilters) => void;
  sources: Source[];
  fields?: FilterField[];
}) {
  const has = (field: FilterField) => fields.includes(field);
  const [searchText, setSearchText] = useState(filters.search ?? '');

  useEffect(() => {
    setSearchText(filters.search ?? '');
  }, [filters.search]);

  useEffect(() => {
    if (!has('search')) return;
    const trimmed = searchText.trim();
    if (trimmed === (filters.search ?? '')) return;
    const timer = setTimeout(() => {
      onChange({ ...filters, search: trimmed || undefined });
    }, 300);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchText]);

  return (
    <div className={styles.bar}>
      {has('period') && (
        <div className={styles.field}>
          <label className={styles.label} htmlFor="filter-period">
            Период
          </label>
          <select
            id="filter-period"
            className={styles.select}
            value={filters.period}
            onChange={(e) => onChange({ ...filters, period: e.target.value as PeriodPreset })}
          >
            {(Object.keys(PERIOD_LABELS) as PeriodPreset[]).map((period) => (
              <option key={period} value={period}>
                {PERIOD_LABELS[period]}
              </option>
            ))}
          </select>
        </div>
      )}

      {has('period') && filters.period === 'custom' && (
        <div className={styles.dateRange}>
          <div className={styles.field}>
            <label className={styles.label} htmlFor="filter-date-from">
              С даты
            </label>
            <input
              id="filter-date-from"
              type="date"
              className={styles.dateInput}
              value={toDateInputValue(filters.dateFrom)}
              onChange={(e) => onChange({ ...filters, dateFrom: e.target.value ? new Date(e.target.value).toISOString() : undefined })}
            />
          </div>
          <div className={styles.field}>
            <label className={styles.label} htmlFor="filter-date-to">
              По дату
            </label>
            <input
              id="filter-date-to"
              type="date"
              className={styles.dateInput}
              value={toDateInputValue(filters.dateTo)}
              onChange={(e) => onChange({ ...filters, dateTo: e.target.value ? new Date(e.target.value).toISOString() : undefined })}
            />
          </div>
        </div>
      )}

      {has('sentiment') && (
        <div className={styles.field}>
          <label className={styles.label} htmlFor="filter-sentiment">
            Тональность
          </label>
          <select
            id="filter-sentiment"
            className={styles.select}
            value={filters.sentiment ?? ''}
            onChange={(e) => onChange({ ...filters, sentiment: (e.target.value || undefined) as Sentiment | undefined })}
          >
            <option value="">Все</option>
            {(Object.keys(SENTIMENT_LABELS) as Sentiment[]).map((sentiment) => (
              <option key={sentiment} value={sentiment}>
                {SENTIMENT_LABELS[sentiment]}
              </option>
            ))}
          </select>
        </div>
      )}

      {has('source') && (
        <div className={styles.field}>
          <label className={styles.label} htmlFor="filter-source">
            Источник
          </label>
          <select
            id="filter-source"
            className={styles.select}
            value={filters.sourceId ?? ''}
            onChange={(e) => onChange({ ...filters, sourceId: e.target.value || undefined })}
          >
            <option value="">Все источники</option>
            {sources.map((source) => (
              <option key={source.id} value={source.id}>
                {source.name ?? source.url}
              </option>
            ))}
          </select>
        </div>
      )}

      {has('sourceType') && (
        <div className={styles.field}>
          <label className={styles.label} htmlFor="filter-source-type">
            Тип
          </label>
          <select
            id="filter-source-type"
            className={styles.select}
            value={filters.sourceType ?? ''}
            onChange={(e) => onChange({ ...filters, sourceType: (e.target.value || undefined) as MentionSourceType | undefined })}
          >
            <option value="">Все типы</option>
            {(Object.keys(MENTION_SOURCE_TYPE_LABELS) as MentionSourceType[]).map((type) => (
              <option key={type} value={type}>
                {MENTION_SOURCE_TYPE_LABELS[type]}
              </option>
            ))}
          </select>
        </div>
      )}

      {has('language') && (
        <div className={styles.field}>
          <label className={styles.label} htmlFor="filter-language">
            Язык
          </label>
          <select
            id="filter-language"
            className={styles.select}
            value={filters.language ?? ''}
            onChange={(e) => onChange({ ...filters, language: e.target.value || undefined })}
          >
            <option value="">Все языки</option>
            {Object.entries(LANGUAGE_LABELS).map(([code, label]) => (
              <option key={code} value={code}>
                {label}
              </option>
            ))}
          </select>
        </div>
      )}

      {has('search') && (
        <div className={styles.searchWrap}>
          <label className={styles.label} htmlFor="filter-search">
            Поиск по тексту
          </label>
          <input
            id="filter-search"
            type="search"
            className={styles.searchInput}
            placeholder="Например, «QazCloud»"
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
          />
        </div>
      )}
    </div>
  );
}
