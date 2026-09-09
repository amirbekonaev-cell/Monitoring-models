import { MentionsStats } from '../../types/domain';
import styles from './TopSourcesTable.module.css';

export function TopSourcesTable({ topSources }: { topSources: MentionsStats['topSources'] }) {
  if (topSources.length === 0) {
    return <p className={styles.empty}>Нет упоминаний за выбранный период.</p>;
  }

  const max = Math.max(...topSources.map((s) => s.count));

  return (
    <table className={styles.table}>
      <thead>
        <tr>
          <th>Источник</th>
          <th>Упоминаний</th>
          <th className={styles.shareCell}>Доля</th>
        </tr>
      </thead>
      <tbody>
        {topSources.map((source) => (
          <tr key={source.sourceId ?? 'none'}>
            <td className={styles.name}>{source.name ?? 'Без источника'}</td>
            <td className={styles.count}>{source.count}</td>
            <td className={styles.shareCell}>
              <div className={styles.shareTrack}>
                <div className={styles.shareFill} style={{ width: `${(source.count / max) * 100}%` }} />
              </div>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
