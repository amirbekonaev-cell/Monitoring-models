import { ReactNode } from 'react';
import styles from './AppShell.module.css';

export type Section = 'dashboard' | 'feed' | 'sources' | 'keywords';

const SECTIONS: Array<{ key: Section; label: string }> = [
  { key: 'dashboard', label: 'Дашборд' },
  { key: 'feed', label: 'Лента' },
  { key: 'sources', label: 'Источники' },
  { key: 'keywords', label: 'Ключевые слова' },
];

export function AppShell({
  section,
  onSectionChange,
  children,
}: {
  section: Section;
  onSectionChange: (section: Section) => void;
  children: ReactNode;
}) {
  return (
    <div className={styles.shell}>
      <aside className={styles.sidebar}>
        <div className={styles.brand}>
          QazCloud
          <span className={styles.brandSub}>Мониторинг упоминаний</span>
        </div>
        <nav className={styles.nav} aria-label="Разделы">
          {SECTIONS.map((item) => (
            <button
              key={item.key}
              type="button"
              className={`${styles.navItem} ${section === item.key ? styles.navItemActive : ''}`}
              aria-current={section === item.key ? 'page' : undefined}
              onClick={() => onSectionChange(item.key)}
            >
              {item.label}
            </button>
          ))}
        </nav>
      </aside>
      <main className={styles.content}>{children}</main>
    </div>
  );
}
