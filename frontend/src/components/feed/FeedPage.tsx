import { useCallback, useEffect, useState } from 'react';
import { fetchMentions } from '../../api/mentions';
import { fetchSources } from '../../api/sources';
import { Mention, MentionsFilters, Source } from '../../types/domain';
import { FilterBar } from '../common/FilterBar';
import { LoadingState } from '../common/LoadingState';
import { ErrorState } from '../common/ErrorState';
import { EmptyState } from '../common/EmptyState';
import { Pagination } from '../common/Pagination';
import { MentionCard } from './MentionCard';
import styles from './FeedPage.module.css';

const PAGE_SIZE = 25;
// «Всё время» — по той же причине, что и на дашборде (см. DashboardPage): в ленте лежит
// последняя выдача бота, и её даты старше недели.
const DEFAULT_FILTERS: MentionsFilters = { period: 'all' };

export function FeedPage() {
  const [filters, setFilters] = useState<MentionsFilters>(DEFAULT_FILTERS);
  const [page, setPage] = useState(1);
  const [items, setItems] = useState<Mention[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sources, setSources] = useState<Source[]>([]);

  useEffect(() => {
    fetchSources()
      .then(setSources)
      .catch(() => {
        // Список источников для фильтра — не критичен для самой ленты, молча оставляем пустым.
      });
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchMentions(filters, PAGE_SIZE, (page - 1) * PAGE_SIZE);
      setItems(data.items);
      setTotal(data.total);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось загрузить упоминания');
    } finally {
      setLoading(false);
    }
  }, [filters, page]);

  useEffect(() => {
    load();
  }, [load]);

  function handleFiltersChange(next: MentionsFilters) {
    setFilters(next);
    setPage(1);
  }

  function handleSentimentChanged(updated: Mention) {
    setItems((prev) => prev.map((item) => (item.id === updated.id ? updated : item)));
  }

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const hasActiveFilters = Boolean(
    filters.sentiment ||
      filters.sourceId ||
      filters.sourceType ||
      filters.language ||
      filters.search ||
      filters.period !== DEFAULT_FILTERS.period,
  );

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <h1 className={styles.title}>Лента упоминаний</h1>
        {!loading && !error && <span className={styles.resultCount}>{total} упоминаний найдено</span>}
      </div>

      <FilterBar filters={filters} onChange={handleFiltersChange} sources={sources} />

      {loading && <LoadingState label="Загружаем упоминания…" />}
      {!loading && error && <ErrorState message={error} onRetry={load} />}
      {!loading && !error && items.length === 0 && (
        <EmptyState
          title="Упоминаний не найдено"
          description={
            hasActiveFilters
              ? 'Ни одно упоминание не подходит под текущие фильтры — попробуйте расширить период или снять часть условий.'
              : 'Сборщик ещё не нашёл материалы по текущим ключевым словам и источникам — подождите цикл сбора или запустите /search в Telegram-боте.'
          }
        />
      )}
      {!loading && !error && items.length > 0 && (
        <>
          <div className={styles.list}>
            {items.map((mention) => (
              <MentionCard key={mention.id} mention={mention} onChanged={handleSentimentChanged} />
            ))}
          </div>
          <Pagination page={page} pageCount={pageCount} onChange={setPage} />
        </>
      )}
    </div>
  );
}
