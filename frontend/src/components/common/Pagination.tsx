import styles from './Pagination.module.css';

export function Pagination({
  page,
  pageCount,
  onChange,
}: {
  page: number;
  pageCount: number;
  onChange: (page: number) => void;
}) {
  if (pageCount <= 1) return null;

  return (
    <nav className={styles.bar} aria-label="Страницы">
      <button type="button" className={styles.button} onClick={() => onChange(page - 1)} disabled={page <= 1}>
        ‹ Назад
      </button>
      <span className={styles.status}>
        Стр. {page} из {pageCount}
      </span>
      <button type="button" className={styles.button} onClick={() => onChange(page + 1)} disabled={page >= pageCount}>
        Далее ›
      </button>
    </nav>
  );
}
