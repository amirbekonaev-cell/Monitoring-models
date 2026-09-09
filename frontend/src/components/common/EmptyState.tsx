import styles from './StateMessage.module.css';

export function EmptyState({
  title,
  description,
  actionLabel,
  onAction,
}: {
  title: string;
  description?: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <div className={styles.container}>
      <span className={styles.title}>{title}</span>
      {description && <span className={styles.description}>{description}</span>}
      {actionLabel && onAction && (
        <button type="button" className={styles.button} onClick={onAction}>
          {actionLabel}
        </button>
      )}
    </div>
  );
}
