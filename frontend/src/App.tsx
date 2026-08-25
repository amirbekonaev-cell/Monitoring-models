import { useEffect, useState } from 'react';
import { fetchMentions, Mention } from './api/mentions';
import { MentionsList } from './components/MentionsList';
import { SourcesPage } from './components/SourcesPage';
import { KeywordsPage } from './components/KeywordsPage';

type Tab = 'feed' | 'sources' | 'keywords';

function FeedTab() {
  const [items, setItems] = useState<Mention[]>([]);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  async function load() {
    try {
      const data = await fetchMentions();
      setItems(data.items);
      setTotal(data.total);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось загрузить упоминания');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    const interval = setInterval(load, 30000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div>
      <h1>Лента упоминаний</h1>
      <p>Всего в базе: {total}</p>
      {loading && <p>Загрузка…</p>}
      {error && <p style={{ color: 'crimson' }}>Ошибка: {error}</p>}
      {!loading && !error && <MentionsList items={items} />}
    </div>
  );
}

export default function App() {
  const [tab, setTab] = useState<Tab>('feed');

  const tabs: Array<{ key: Tab; label: string }> = [
    { key: 'feed', label: 'Лента' },
    { key: 'sources', label: 'Источники' },
    { key: 'keywords', label: 'Ключевые слова' },
  ];

  return (
    <div style={{ maxWidth: 960, margin: '0 auto', padding: 24, fontFamily: 'sans-serif' }}>
      <nav style={{ display: 'flex', gap: 8, marginBottom: 24, borderBottom: '1px solid #ddd', paddingBottom: 12 }}>
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            style={{
              padding: '8px 16px',
              fontWeight: tab === t.key ? 700 : 400,
              background: tab === t.key ? '#eee' : 'transparent',
              border: '1px solid #ddd',
              borderRadius: 6,
              cursor: 'pointer',
            }}
          >
            {t.label}
          </button>
        ))}
      </nav>

      {tab === 'feed' && <FeedTab />}
      {tab === 'sources' && <SourcesPage />}
      {tab === 'keywords' && <KeywordsPage />}
    </div>
  );
}
