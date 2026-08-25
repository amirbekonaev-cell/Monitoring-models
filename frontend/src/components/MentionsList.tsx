import { Mention } from '../api/mentions';

function formatDate(value: string | null): string {
  if (!value) return '—';
  return new Date(value).toLocaleString('ru-RU');
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
          <div style={{ fontWeight: 600, marginBottom: 4 }}>
            <a href={mention.url} target="_blank" rel="noreferrer">
              {mention.title}
            </a>
          </div>
          <div style={{ fontSize: 13, color: '#666', marginBottom: 8 }}>
            {formatDate(mention.publishedAt)} · {mention.sourceType} · тональность: {mention.sentiment}
          </div>
          {mention.text && <div style={{ fontSize: 14 }}>{mention.text.slice(0, 240)}</div>}
        </li>
      ))}
    </ul>
  );
}
