import styles from './StateMessage.module.css';

export function LoadingState({ label = 'Загружаем данные…' }: { label?: string }) {
  return (
    <div className={styles.container} role="status" aria-live="polite">
      <span className={styles.title}>{label}</span>
      <span className={styles.pulseBar} aria-hidden />
    </div>
  );
}
