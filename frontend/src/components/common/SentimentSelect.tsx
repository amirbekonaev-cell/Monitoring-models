import { ChangeEvent, useState } from 'react';
import { Mention, Sentiment } from '../../types/domain';
import { updateMentionSentiment } from '../../api/mentions';
import { SENTIMENT_LABELS } from '../../styles/theme';
import styles from './SentimentSelect.module.css';

const OPTIONS: Sentiment[] = ['positive', 'negative', 'neutral', 'undefined'];

/** Инлайн-редактор тональности прямо в карточке ленты — PATCH /mentions/:id/sentiment (ФТ-11). */
export function SentimentSelect({
  mentionId,
  sentiment,
  onChanged,
}: {
  mentionId: string;
  sentiment: Sentiment;
  onChanged: (mention: Mention) => void;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleChange(event: ChangeEvent<HTMLSelectElement>) {
    const next = event.target.value as Sentiment;
    if (next === sentiment) return;
    setSaving(true);
    setError(null);
    try {
      const updated = await updateMentionSentiment(mentionId, next);
      onChanged(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось сохранить');
    } finally {
      setSaving(false);
    }
  }

  return (
    <span className={styles.wrapper}>
      <select
        className={`${styles.select} ${styles[sentiment]}`}
        value={sentiment}
        onChange={handleChange}
        disabled={saving}
        aria-label="Изменить тональность упоминания"
      >
        {OPTIONS.map((option) => (
          <option key={option} value={option}>
            {SENTIMENT_LABELS[option]}
          </option>
        ))}
      </select>
      {error && <span className={styles.error}>{error}</span>}
    </span>
  );
}
