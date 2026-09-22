/**
 * Reports the closed pool's state: counts by status and by group, article date range, and how
 * many pool mentions ended up with each sentiment.
 *
 * Usage:
 *   npm run curated:status
 *   npm run curated:status -- --show-problems
 *
 * `--show-problems` additionally prints the `failed`/`not_relevant` links WITH their URLs. This
 * is the ONE place a pool URL is ever printed, and it goes to the operator's own terminal so a
 * bad link can actually be looked at and fixed — it is never written to a file, a log sink, the
 * README or a commit. Without the flag, only the reason strings are shown.
 */
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CuratedLink, CuratedLinkStatus } from '../curated/curated-link.entity';
import { CuratedSearchService } from '../curated/curated-search.service';
import { createCuratedScriptContext, describeDatabase, hasFlag } from './curated-script-context';

async function main(): Promise<void> {
  const showProblems = hasFlag('show-problems');

  const app = await createCuratedScriptContext();
  const repo = app.get<Repository<CuratedLink>>(getRepositoryToken(CuratedLink));
  const search = app.get(CuratedSearchService);

  console.log(`База: ${describeDatabase()}`);

  const pool = await search.getPoolStats();
  console.log(`Всего ссылок в пуле: ${pool.totalLinks}`);
  console.log('По статусам:');
  for (const status of Object.values(CuratedLinkStatus)) {
    console.log(`  ${status}: ${pool.byStatus[status] ?? 0}`);
  }

  const byGroup = await repo
    .createQueryBuilder('c')
    .select('c.groupLabel', 'groupLabel')
    .addSelect('c.status', 'status')
    .addSelect('COUNT(*)', 'count')
    .groupBy('c.groupLabel')
    .addGroupBy('c.status')
    .getRawMany<{ groupLabel: string | null; status: string; count: string }>();

  const groups = new Map<string, Record<string, number>>();
  for (const row of byGroup) {
    const key = row.groupLabel ?? '(без группы)';
    const entry = groups.get(key) ?? {};
    entry[row.status] = parseInt(row.count, 10);
    groups.set(key, entry);
  }

  console.log('По группам:');
  for (const [group, statuses] of [...groups.entries()].sort()) {
    const total = Object.values(statuses).reduce((a, b) => a + b, 0);
    const detail = Object.entries(statuses)
      .map(([status, count]) => `${status}=${count}`)
      .join(', ');
    console.log(`  ${group}: всего ${total} (${detail})`);
  }

  console.log(`Упоминаний из пула: ${pool.mentionsTotal}, из них без даты: ${pool.undatedMentions}`);
  console.log(
    `Диапазон дат статей: ${pool.firstArticleDate?.toISOString().slice(0, 10) ?? 'нет'} — ` +
      `${pool.lastArticleDate?.toISOString().slice(0, 10) ?? 'нет'}`,
  );
  console.log(`Последняя обработка: ${pool.lastProcessedAt?.toISOString() ?? 'ещё не запускалась'}`);

  const problems = await repo.find({
    where: [{ status: CuratedLinkStatus.FAILED }, { status: CuratedLinkStatus.NOT_RELEVANT }],
    order: { status: 'ASC', host: 'ASC' },
  });

  if (problems.length === 0) {
    console.log('Проблемных ссылок нет.');
  } else if (!showProblems) {
    console.log(`Проблемных ссылок: ${problems.length}. Запустите с --show-problems, чтобы увидеть их список.`);
  } else {
    console.log(`Проблемные ссылки (${problems.length}) — только для этого терминала:`);
    for (const link of problems) {
      console.log(`  [${link.status}] попыток=${link.attempts} · ${link.lastError ?? 'причина не записана'}`);
      console.log(`      ${link.url}`);
    }
  }

  await app.close();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
