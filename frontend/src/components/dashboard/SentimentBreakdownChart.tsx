import { Sentiment } from '../../types/domain';
import { SENTIMENT_COLORS, SENTIMENT_LABELS } from '../../styles/theme';
import styles from './SentimentBreakdownChart.module.css';

const ORDER: Sentiment[] = ['positive', 'negative', 'neutral', 'undefined'];

export function SentimentBreakdownChart({ counts }: { counts: Record<Sentiment, number> }) {
  const total = ORDER.reduce((sum, s) => sum + counts[s], 0);

  return (
    <div className={styles.wrap}>
      <div className={styles.bar}>
        {total > 0 &&
          ORDER.filter((s) => counts[s] > 0).map((sentiment) => (
            <span
              key={sentiment}
              className={styles.segment}
              style={{ width: `${(counts[sentiment] / total) * 100}%`, background: SENTIMENT_COLORS[sentiment] }}
            />
          ))}
      </div>
      <div className={styles.legend}>
        {ORDER.map((sentiment) => {
          const count = counts[sentiment];
          const percent = total > 0 ? Math.round((count / total) * 100) : 0;
          return (
            <div className={styles.row} key={sentiment}>
              <span className={styles.swatch} style={{ background: SENTIMENT_COLORS[sentiment] }} aria-hidden />
              <span className={styles.rowLabel}>{SENTIMENT_LABELS[sentiment]}</span>
              <span className={styles.rowCount}>
                {count} {total > 0 && `(${percent}%)`}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
