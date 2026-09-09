import styles from './StateMessage.module.css';

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className={`${styles.container} ${styles.error}`} role="alert">
      <span className={styles.title}>Не удалось загрузить данные</span>
      <span className={styles.description}>{message}</span>
      {onRetry && (
        <button type="button" className={styles.button} onClick={onRetry}>
          Повторить
        </button>
      )}
    </div>
  );
}
