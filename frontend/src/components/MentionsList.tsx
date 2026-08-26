import { Mention } from '../api/mentions';

function formatDate(value: string | null): string {
  if (!value) return '—';
  return new Date(value).toLocaleString('ru-RU');
}

const SENTIMENT_LABEL: Record<string, string> = {
  positive: 'Позитив',
  negative: 'Негатив',
  neutral: 'Нейтрал',
  undefined: 'Не определена',
};

const SENTIMENT_COLOR: Record<string, string> = {
  positive: '#2e7d32',
  negative: '#c62828',
  neutral: '#f9a825',
  undefined: '#616161',
};

function SentimentBadge({ sentiment }: { sentiment: string }) {
  const label = SENTIMENT_LABEL[sentiment] ?? SENTIMENT_LABEL.undefined;
  const color = SENTIMENT_COLOR[sentiment] ?? SENTIMENT_COLOR.undefined;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <span
        aria-hidden
        style={{ width: 10, height: 10, borderRadius: 2, backgroundColor: color, display: 'inline-block' }}
      />
      {label}
    </span>
  );
}

export function MentionsList({ items }: { items: Mention[] }) {
  if (items.length === 0) {
    return <p>Пока нет упоминаний. Сборщик ещё не нашёл материалы — подождите цикл сбора.</p>;
  }

  return (
    <ul style={{ listStyle: 'none', padding: 0 }}>
      {items.map((mention) => (
        <li
          key={mention.id}
          style={{ border: '1px solid #ddd', borderRadius: 8, padding: 16, marginBottom: 12 }}
        >
          <div style={{ marginBottom: 4 }}>
            <SentimentBadge sentiment={mention.sentiment} />
          </div>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>
            <a href={mention.url} target="_blank" rel="noreferrer">
              {mention.title}
            </a>
          </div>
          <div style={{ fontSize: 13, color: '#666', marginBottom: 8 }}>
            {formatDate(mention.publishedAt)} · {mention.sourceType}
          </div>
          {mention.text && <div style={{ fontSize: 14 }}>{mention.text.slice(0, 240)}</div>}
        </li>
      ))}
    </ul>
  );
}