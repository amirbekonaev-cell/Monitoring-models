import { FormEvent, useCallback, useEffect, useState } from 'react';
import { addSource, deleteSource, fetchSources, setSourceEnabled } from '../../api/sources';
import { Source } from '../../types/domain';
import { SOURCE_KIND_LABELS } from '../../constants/labels';
import { LoadingState } from '../common/LoadingState';
import { ErrorState } from '../common/ErrorState';
import { EmptyState } from '../common/EmptyState';
import { StatusPill } from '../common/StatusPill';
import styles from './SourcesPage.module.css';

function formatDate(value: string | null): string {
  if (!value) return '—';
  return new Date(value).toLocaleString('ru-RU');
}

export function SourcesPage() {
  const [sources, setSources] = useState<Source[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [url, setUrl] = useState('');
  const [name, setName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [feedback, setFeedback] = useState<{ ok: boolean; message: string; deepScanNote?: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchSources();
      setSources(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось загрузить источники');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!url.trim()) return;
    setSubmitting(true);
    setFeedback(null);
    try {
      const result = await addSource(url.trim(), name.trim() || undefined);
      setFeedback({ ok: result.ok, message: result.message, deepScanNote: result.deepScanNote });
      setUrl('');
      setName('');
      await load();
    } catch (err) {
      setFeedback({ ok: false, message: err instanceof Error ? err.message : 'Не удалось добавить источник' });
    } finally {
      setSubmitting(false);
    }
  }

  async function handleToggle(source: Source) {
    await setSourceEnabled(source.id, source.status === 'disabled');
    await load();
  }

  async function handleDelete(source: Source) {
    if (!confirm(`Удалить источник «${source.name ?? source.url}»? Уже собранные упоминания останутся в базе.`)) {
      return;
    }
    await deleteSource(source.id);
    await load();
  }

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <h1 className={styles.title}>Источники</h1>
      </div>

      <form onSubmit={handleSubmit} className={styles.form}>
        <input
          type="text"
          placeholder="Ссылка: сайт, RSS-лента или t.me/канал"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          className={`${styles.input} ${styles.inputUrl}`}
          required
        />
        <input
          type="text"
          placeholder="Название (необязательно)"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className={`${styles.input} ${styles.inputName}`}
        />
        <button type="submit" disabled={submitting} className={styles.submitButton}>
          {submitting ? 'Добавляем и проверяем…' : 'Добавить по ссылке'}
        </button>
      </form>

      {feedback && (
        <div className={`${styles.feedback} ${feedback.ok ? styles.feedbackOk : styles.feedbackError}`}>
          {feedback.message}
          {feedback.deepScanNote && <div className={styles.feedbackNote}>{feedback.deepScanNote}</div>}
        </div>
      )}

      {loading && <LoadingState label="Загружаем источники…" />}
      {!loading && error && <ErrorState message={error} onRetry={load} />}
      {!loading && !error && sources.length === 0 && (
        <EmptyState title="Источников пока нет" description="Добавьте первый источник по ссылке — сайт, RSS-лента или Telegram-канал." />
      )}
      {!loading && !error && sources.length > 0 && (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Источник</th>
                <th>Тип</th>
                <th>Статус</th>
                <th>Последний успешный сбор</th>
                <th>Упоминаний</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {sources.map((source) => (
                <tr key={source.id}>
                  <td>
                    <div className={styles.name}>{source.name ?? source.url}</div>
                    <div className={styles.url}>{source.url}</div>
                    {source.status === 'error' && source.lastError && <div className={styles.lastError}>{source.lastError}</div>}
                  </td>
                  <td>{SOURCE_KIND_LABELS[source.type]}</td>
                  <td>
                    <StatusPill status={source.status} />
                  </td>
                  <td>{formatDate(source.lastSuccessAt)}</td>
                  <td className={styles.count}>{source.mentionsCount}</td>
                  <td>
                    <div className={styles.actions}>
                      <button type="button" className={styles.actionButton} onClick={() => handleToggle(source)}>
                        {source.status === 'disabled' ? 'Включить' : 'Отключить'}
                      </button>
                      <button type="button" className={styles.actionButton} onClick={() => handleDelete(source)}>
                        Удалить
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
