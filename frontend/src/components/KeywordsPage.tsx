import { FormEvent, useEffect, useState } from 'react';
import { createKeyword, deleteKeyword, fetchKeywords, Keyword, KeywordType, updateKeyword } from '../api/keywords';

const TYPE_LABELS: Record<KeywordType, string> = {
  required: 'Обязательное',
  minus: 'Минус-слово',
  exact_phrase: 'Точная фраза',
};

export function KeywordsPage() {
  const [keywords, setKeywords] = useState<Keyword[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [phrase, setPhrase] = useState('');
  const [type, setType] = useState<KeywordType>('required');
  const [language, setLanguage] = useState('ru');
  const [manualFormsText, setManualFormsText] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function load() {
    try {
      const data = await fetchKeywords();
      setKeywords(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось загрузить ключевые слова');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!phrase.trim()) return;
    setSubmitting(true);
    try {
      const manualForms = manualFormsText
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      await createKeyword({ phrase: phrase.trim(), type, language, manualForms });
      setPhrase('');
      setManualFormsText('');
      await load();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Не удалось добавить ключевое слово');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleToggleActive(keyword: Keyword) {
    await updateKeyword(keyword.id, { isActive: !keyword.isActive });
    await load();
  }

  async function handleDelete(keyword: Keyword) {
    if (!confirm(`Удалить ключевое слово «${keyword.phrase}»?`)) return;
    await deleteKeyword(keyword.id);
    await load();
  }

  const activeCount = keywords.filter((k) => k.isActive).length;

  return (
    <div>
      <h1>Ключевые слова</h1>
      <p style={{ color: '#666' }}>
        Активных сейчас: {activeCount}. Изменения применяются только к следующему циклу сбора — уже собранные
        упоминания не пересчитываются.
      </p>

      <form onSubmit={handleSubmit} style={{ marginBottom: 20, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <input
          type="text"
          placeholder='Слово или "точная фраза"'
          value={phrase}
          onChange={(e) => setPhrase(e.target.value)}
          style={{ flex: '1 1 220px', padding: 8 }}
          required
        />
        <select value={type} onChange={(e) => setType(e.target.value as KeywordType)} style={{ padding: 8 }}>
          <option value="required">Обязательное</option>
          <option value="minus">Минус-слово</option>
          <option value="exact_phrase">Точная фраза</option>
        </select>
        <select value={language} onChange={(e) => setLanguage(e.target.value)} style={{ padding: 8 }}>
          <option value="ru">Русский (автоморфология)</option>
          <option value="kk">Казахский (нужны словоформы вручную)</option>
        </select>
        <input
          type="text"
          placeholder="Словоформы вручную через запятую (для kk)"
          value={manualFormsText}
          onChange={(e) => setManualFormsText(e.target.value)}
          style={{ flex: '1 1 260px', padding: 8 }}
        />
        <button type="submit" disabled={submitting} style={{ padding: '8px 16px' }}>
          Добавить
        </button>
      </form>

      {loading && <p>Загрузка…</p>}
      {error && <p style={{ color: 'crimson' }}>Ошибка: {error}</p>}

      {!loading && !error && (
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ textAlign: 'left', borderBottom: '2px solid #ddd' }}>
              <th style={{ padding: 8 }}>Фраза</th>
              <th style={{ padding: 8 }}>Тип</th>
              <th style={{ padding: 8 }}>Язык</th>
              <th style={{ padding: 8 }}>Словоформы</th>
              <th style={{ padding: 8 }}>Активно</th>
              <th style={{ padding: 8 }}></th>
            </tr>
          </thead>
          <tbody>
            {keywords.map((k) => (
              <tr key={k.id} style={{ borderBottom: '1px solid #eee', opacity: k.isActive ? 1 : 0.5 }}>
                <td style={{ padding: 8, fontWeight: 600 }}>{k.phrase}</td>
                <td style={{ padding: 8 }}>{TYPE_LABELS[k.type]}</td>
                <td style={{ padding: 8 }}>{k.language}</td>
                <td style={{ padding: 8, fontSize: 12, color: '#666' }}>{k.manualForms.join(', ') || '—'}</td>
                <td style={{ padding: 8 }}>
                  <input type="checkbox" checked={k.isActive} onChange={() => handleToggleActive(k)} />
                </td>
                <td style={{ padding: 8 }}>
                  <button onClick={() => handleDelete(k)}>Удалить</button>
                </td>
              </tr>
            ))}
            {keywords.length === 0 && (
              <tr>
                <td colSpan={6} style={{ padding: 16, textAlign: 'center', color: '#666' }}>
                  Ключевых слов пока нет — без них лента показывает всё подряд.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      )}
    </div>
  );
}