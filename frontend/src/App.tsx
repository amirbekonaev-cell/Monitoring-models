import { lazy, Suspense, useState } from 'react';
import { AppShell, Section } from './components/layout/AppShell';
import { FeedPage } from './components/feed/FeedPage';
import { SourcesPage } from './components/sources/SourcesPage';
import { KeywordsPage } from './components/keywords/KeywordsPage';
import { LoadingState } from './components/common/LoadingState';

// recharts (только для дашборда) — самая тяжёлая зависимость в проекте, поэтому дашборд
// выносится в отдельный чанк и подгружается только при переходе на этот раздел.
const DashboardPage = lazy(() => import('./components/dashboard/DashboardPage').then((m) => ({ default: m.DashboardPage })));

export default function App() {
  const [section, setSection] = useState<Section>('dashboard');

  return (
    <AppShell section={section} onSectionChange={setSection}>
      {section === 'dashboard' && (
        <Suspense fallback={<LoadingState label="Загружаем дашборд…" />}>
          <DashboardPage />
        </Suspense>
      )}
      {section === 'feed' && <FeedPage />}
      {section === 'sources' && <SourcesPage />}
      {section === 'keywords' && <KeywordsPage />}
    </AppShell>
  );
}
