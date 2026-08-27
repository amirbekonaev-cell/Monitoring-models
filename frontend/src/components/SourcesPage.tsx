import { FormEvent, useEffect, useState } from 'react';
import { addSource, deleteSource, fetchSources, setSourceEnabled, Source } from '../api/sources';

const TYPE_LABELS: Record<Source['type'], string> = {
  rss: 'RSS (К-2)',
  telegram: 'Telegram (К-3)',
  parser: 'Универсальный парсер (К-5)',
  search_api: 'Поисковый API (К-1)',
  social_api: 'Соцсеть VK (К-4)',
  social_search_api: 'Соцсети через OpenAI web search (К-6)',
};

const STATUS_LABELS: Record<Source['status'], { label: string; color: string }> = {
  active: { label: 'работает', color: '#1a7f37' },
  error: { label: 'ошибка', color: '#cf222e' },
  disabled: { label: 'отключён', color: '#666' },
};

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

  async function load() {
    try {
      const data = await fetchSources();
      setSources(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось загрузить источники');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

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
    if (!confirm(`Удалить источник ${source.name ?? source.url}? Уже собранные упоминания останутся в базе.`)) {
      return;
    }
    await deleteSource(source.id);
    await load();
  }

  return (
    <div>
      <h1>Источники</h1>

      <form onSubmit={handleSubmit} style={{ marginBottom: 20, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <input
          type="text"
          placeholder="Ссылка: сайт, RSS-лента или t.me/канал"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          style={{ flex: '1 1 320px', padding: 8 }}
          required
        />
        <input
          type="text"
          placeholder="Название (необязательно)"
          value={name}
          onChange={(e) => setName(e.target.value)}
          style={{ flex: '1 1 200px', padding: 8 }}
        />
        <button type="submit" disabled={submitting} style={{ padding: '8px 16px' }}>
          {submitting ? 'Добавляем и проверяем…' : 'Добавить по ссылке'}
        </button>
      </form>

      {feedback && (
        <div style={{ marginBottom: 16 }}>
          <p style={{ color: feedback.ok ? '#1a7f37' : '#cf222e', margin: 0 }}>{feedback.message}</p>
          {feedback.deepScanNote && (
            <p style={{ color: '#666', fontSize: 13, margin: '4px 0 0' }}>{feedback.deepScanNote}</p>
          )}
        </div>
      )}

      {loading && <p>Загрузка…</p>}
      {error && <p style={{ color: 'crimson' }}>Ошибка: {error}</p>}

      {!loading && !error && (
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ textAlign: 'left', borderBottom: '2px solid #ddd' }}>
              <th style={{ padding: 8 }}>Источник</th>
              <th style={{ padding: 8 }}>Тип</th>
              <th style={{ padding: 8 }}>Статус</th>
              <th style={{ padding: 8 }}>Последний успешный сбор</th>
              <th style={{ padding: 8 }}>Упоминаний</th>
              <th style={{ padding: 8 }}></th>
            </tr>
          </thead>
          <tbody>
            {sources.map((source) => {
              const status = STATUS_LABELS[source.status];
              return (
                <tr key={source.id} style={{ borderBottom: '1px solid #eee' }}>
                  <td style={{ padding: 8 }}>
                    <div style={{ fontWeight: 600 }}>{source.name ?? source.url}</div>
                    <div style={{ fontSize: 12, color: '#666', wordBreak: 'break-all' }}>{source.url}</div>
                    {source.status === 'error' && source.lastError && (
                      <div style={{ fontSize: 12, color: '#cf222e' }}>{source.lastError}</div>
                    )}
                  </td>
                  <td style={{ padding: 8 }}>{TYPE_LABELS[source.type]}</td>
                  <td style={{ padding: 8, color: status.color, fontWeight: 600 }}>{status.label}</td>
                  <td style={{ padding: 8 }}>{formatDate(source.lastSuccessAt)}</td>
                  <td style={{ padding: 8 }}>{source.mentionsCount}</td>
                  <td style={{ padding: 8, whiteSpace: 'nowrap' }}>
                    <button onClick={() => handleToggle(source)} style={{ marginRight: 8 }}>
                      {source.status === 'disabled' ? 'Включить' : 'Отключить'}
                    </button>
                    <button onClick={() => handleDelete(source)}>Удалить</button>
                  </td>
                </tr>
              );
            })}
            {sources.length === 0 && (
              <tr>
                <td colSpan={6} style={{ padding: 16, textAlign: 'center', color: '#666' }}>
                  Источников пока нет
                </td>
              </tr>
            )}
          </tbody>
        </table>
      )}
    </div>
  );
}