import { SourceStatus } from '../../types/domain';
import styles from './StatusPill.module.css';

const LABELS: Record<SourceStatus, string> = {
  active: 'работает',
  error: 'ошибка',
  disabled: 'отключён',
};

export function StatusPill({ status }: { status: SourceStatus }) {
  return (
    <span className={`${styles.pill} ${styles[status]}`}>
      <span className={styles.dot} aria-hidden />
      {LABELS[status]}
    </span>
  );
}
