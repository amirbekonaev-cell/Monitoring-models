import { Sentiment } from '../../types/domain';
import { SENTIMENT_LABELS } from '../../styles/theme';
import styles from './SentimentBadge.module.css';

export function SentimentBadge({ sentiment }: { sentiment: Sentiment }) {
  return (
    <span className={`${styles.badge} ${styles[sentiment]}`}>
      <span className={styles.dot} aria-hidden />
      {SENTIMENT_LABELS[sentiment]}
    </span>
  );
}
