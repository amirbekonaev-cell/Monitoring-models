import { useCallback, useEffect, useState } from 'react';
import { fetchMentionStats } from '../../api/mentions';
import { MentionsFilters, MentionsStats } from '../../types/domain';
import { FilterBar } from '../common/FilterBar';
import { LoadingState } from '../common/LoadingState';
import { ErrorState } from '../common/ErrorState';
import { EmptyState } from '../common/EmptyState';
import { StatTile } from './StatTile';
import { MentionsTrendChart } from './MentionsTrendChart';
import { SentimentBreakdownChart } from './SentimentBreakdownChart';
import { TopSourcesTable } from './TopSourcesTable';
import styles from './DashboardPage.module.css';

const DEFAULT_FILTERS: MentionsFilters = { period: '7d' };

export function DashboardPage() {
  const [filters, setFilters] = useState<MentionsFilters>(DEFAULT_FILTERS);
  const [stats, setStats] = useState<MentionsStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchMentionStats(filters);
      setStats(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось загрузить статистику');
    } finally {
      setLoading(false);
    }
  }, [filters]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <h1 className={styles.title}>Дашборд</h1>
      </div>

      <FilterBar filters={filters} onChange={setFilters} sources={[]} fields={['period']} />

      {loading && <LoadingState label="Считаем статистику…" />}
      {!loading && error && <ErrorState message={error} onRetry={load} />}
      {!loading && !error && stats && stats.total === 0 && (
        <EmptyState
          title="За выбранный период упоминаний не найдено"
          description="Попробуйте выбрать более широкий период или проверьте, что источники и ключевые слова настроены на вкладках «Источники»/«Ключевые слова»."
        />
      )}
      {!loading && !error && stats && stats.total > 0 && (
        <>
          <div className={styles.grid}>
            <div className={styles.panel}>
              <StatTile label="Всего упоминаний за период" value={stats.total} changePercent={stats.changePercent} />
            </div>
            <div className={styles.panel}>
              <h2 className={styles.panelTitle}>Упоминания по дням</h2>
              <MentionsTrendChart data={stats.byDay} />
            </div>
            <div className={styles.panel}>
              <h2 className={styles.panelTitle}>Тональность</h2>
              <SentimentBreakdownChart counts={stats.bySentiment} />
            </div>
          </div>
          <div className={styles.panel}>
            <h2 className={styles.panelTitle}>Топ источников</h2>
            <TopSourcesTable topSources={stats.topSources} />
          </div>
        </>
      )}
    </div>
  );
}
