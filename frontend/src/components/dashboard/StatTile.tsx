import styles from './StatTile.module.css';

export function StatTile({ label, value, changePercent }: { label: string; value: number; changePercent: number | null }) {
  return (
    <div className={styles.tile}>
      <span className={styles.label}>{label}</span>
      <span className={styles.value}>{value.toLocaleString('ru-RU')}</span>
      <span className={styles.change}>
        {changePercent === null
          ? 'Нет данных за предыдущий период'
          : `${changePercent >= 0 ? '▲' : '▼'} ${Math.abs(changePercent)}% к предыдущему периоду`}
      </span>
    </div>
  );
}
