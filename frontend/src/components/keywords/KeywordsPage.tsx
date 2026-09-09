import { FormEvent, useCallback, useEffect, useState } from 'react';
import { createKeyword, deleteKeyword, fetchKeywords, updateKeyword } from '../../api/keywords';
import { Keyword, KeywordType } from '../../types/domain';
import { LoadingState } from '../common/LoadingState';
import { ErrorState } from '../common/ErrorState';
import styles from './KeywordsPage.module.css';

export function KeywordsPage() {
  const [keywords, setKeywords] = useState<Keyword[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [phrase, setPhrase] = useState('');
  const [type, setType] = useState<KeywordType>('required');
  const [language, setLanguage] = useState('ru');
  const [manualFormsText, setManualFormsText] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchKeywords();
      setKeywords(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось загрузить ключевые слова');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

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
  const positive = keywords.filter((k) => k.type !== 'minus');
  const minus = keywords.filter((k) => k.type === 'minus');

  function renderTable(list: Keyword[], emptyText: string) {
    if (list.length === 0) {
      return <p className={styles.emptyColumn}>{emptyText}</p>;
    }
    return (
      <table className={styles.table}>
        <thead>
          <tr>
            <th>Фраза</th>
            <th>Язык</th>
            <th>Словоформы</th>
            <th>Активно</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {list.map((k) => (
            <tr key={k.id} className={k.isActive ? undefined : styles.inactiveRow}>
              <td className={styles.phrase}>{k.type === 'exact_phrase' ? `«${k.phrase}»` : k.phrase}</td>
              <td>{k.language}</td>
              <td className={styles.forms}>{k.manualForms.join(', ') || '—'}</td>
              <td>
                <input type="checkbox" checked={k.isActive} onChange={() => handleToggleActive(k)} aria-label="Активно" />
              </td>
              <td>
                <button type="button" className={styles.actionButton} onClick={() => handleDelete(k)}>
                  Удалить
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  }

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <h1 className={styles.title}>Ключевые слова</h1>
        <span className={styles.subtitle}>
          Активных сейчас: {activeCount}. Изменения применяются только к следующему циклу сбора — уже собранные упоминания не
          пересчитываются.
        </span>
      </div>

      <form onSubmit={handleSubmit} className={styles.form}>
        <input
          type="text"
          placeholder='Слово или "точная фраза"'
          value={phrase}
          onChange={(e) => setPhrase(e.target.value)}
          className={`${styles.input} ${styles.inputPhrase}`}
          required
        />
        <select value={type} onChange={(e) => setType(e.target.value as KeywordType)} className={styles.select}>
          <option value="required">Обязательное</option>
          <option value="exact_phrase">Точная фраза</option>
          <option value="minus">Минус-слово</option>
        </select>
        <select value={language} onChange={(e) => setLanguage(e.target.value)} className={styles.select}>
          <option value="ru">Русский (автоморфология)</option>
          <option value="kk">Казахский (нужны словоформы вручную)</option>
        </select>
        <input
          type="text"
          placeholder="Словоформы вручную через запятую (для kk)"
          value={manualFormsText}
          onChange={(e) => setManualFormsText(e.target.value)}
          className={`${styles.input} ${styles.inputForms}`}
        />
        <button type="submit" disabled={submitting} className={styles.submitButton}>
          Добавить
        </button>
      </form>

      {loading && <LoadingState label="Загружаем ключевые слова…" />}
      {!loading && error && <ErrorState message={error} onRetry={load} />}
      {!loading && !error && (
        <div className={styles.columns}>
          <div className={styles.column}>
            <div className={styles.columnHeader}>
              <h2 className={styles.columnTitle}>Обязательные и точные фразы</h2>
              <div className={styles.columnHint}>Материал должен совпасть хотя бы с одним активным словом отсюда.</div>
            </div>
            {renderTable(positive, 'Пока нет ни одного обязательного слова — без них лента показывает всё подряд.')}
          </div>
          <div className={styles.column}>
            <div className={styles.columnHeader}>
              <h2 className={styles.columnTitle}>Минус-слова</h2>
              <div className={styles.columnHint}>Совпадение с любым активным минус-словом исключает материал.</div>
            </div>
            {renderTable(minus, 'Минус-слов пока нет.')}
          </div>
        </div>
      )}
    </div>
  );
}
