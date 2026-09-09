import { Mention } from '../../types/domain';
import { SENTIMENT_COLORS } from '../../styles/theme';
import { MENTION_SOURCE_TYPE_LABELS, LANGUAGE_LABELS } from '../../constants/labels';
import { SentimentSelect } from '../common/SentimentSelect';
import styles from './MentionCard.module.css';

function formatDate(value: string | null): string {
  if (!value) return 'Дата неизвестна';
  return new Date(value).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

export function MentionCard({ mention, onChanged }: { mention: Mention; onChanged: (mention: Mention) => void }) {
  const sourceLabel = mention.sourceLabel;

  return (
    <article className={styles.card} style={{ ['--card-accent' as string]: SENTIMENT_COLORS[mention.sentiment] }}>
      <div className={styles.header}>
        <a href={mention.url} target="_blank" rel="noreferrer" className={styles.title}>
          {mention.title}
        </a>
        <SentimentSelect mentionId={mention.id} sentiment={mention.sentiment} onChanged={onChanged} />
      </div>
      <div className={styles.meta}>
        <span>{formatDate(mention.publishedAt)}</span>
        {sourceLabel && <span className={styles.metaSource}>{sourceLabel}</span>}
        <span>{MENTION_SOURCE_TYPE_LABELS[mention.sourceType]}</span>
        {mention.language && <span>{LANGUAGE_LABELS[mention.language] ?? mention.language}</span>}
      </div>
      {mention.text && <p className={styles.snippet}>{mention.text.slice(0, 320)}</p>}
    </article>
  );
}
