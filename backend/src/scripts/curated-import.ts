/**
 * Imports the closed pool's links file into `curated_links`.
 *
 * Usage: npm run curated:import -- [path]       (default: backend/data/curated-links.txt)
 *
 * Idempotent: the insert is ON CONFLICT (url_hash) DO NOTHING, so re-running after adding lines
 * to the file only inserts the new ones and leaves every already-processed link untouched. A
 * duplicate inside the file is counted, not an error (the list is hand-maintained).
 *
 * Prints counters ONLY — never a URL, not even a failing one. A malformed line is reported by
 * its line number so it can be found in the file without its contents appearing in a terminal
 * log or CI output. See README "Приватность".
 */
import * as fs from 'fs';
import * as path from 'path';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CuratedLink, CuratedLinkStatus } from '../curated/curated-link.entity';
import { parseCuratedLinksFile } from '../curated/curated-links-file.util';
import { DomainExclusionService } from '../common/domain-exclusion.service';
import { createCuratedScriptContext, describeDatabase } from './curated-script-context';

const DEFAULT_FILE = path.resolve(__dirname, '../../data/curated-links.txt');

async function main(): Promise<void> {
  const filePath = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_FILE;

  if (!fs.existsSync(filePath)) {
    console.error(
      `Файл со ссылками не найден: ${filePath}\n` +
        'Положите его в backend/data/curated-links.txt (каталог в .gitignore/.dockerignore/.vercelignore) ' +
        'или передайте путь аргументом.',
    );
    process.exit(1);
  }

  const parsed = parseCuratedLinksFile(fs.readFileSync(filePath, 'utf-8'));

  // Stateless, env-driven — instantiated directly, same as in collector-run.util.ts.
  const domainExclusion = new DomainExclusionService();

  const app = await createCuratedScriptContext();
  const repo = app.get<Repository<CuratedLink>>(getRepositoryToken(CuratedLink));

  console.log(`База: ${describeDatabase()}`);
  console.log(
    `Файл разобран: строк=${parsed.stats.totalLines}, строк с URL=${parsed.stats.urlLines}, ` +
      `уникальных URL=${parsed.stats.uniqueUrls}, дублей в файле=${parsed.stats.duplicateUrls}, ` +
      `групп=${parsed.stats.groups}, некорректных URL=${parsed.stats.malformedUrls}`,
  );
  if (parsed.malformedLines.length > 0) {
    console.warn(`Некорректные URL в строках: ${parsed.malformedLines.join(', ')} (содержимое строк не печатается)`);
  }

  let inserted = 0;
  let alreadyKnown = 0;
  let excluded = 0;

  for (const link of parsed.links) {
    const isExcluded = domainExclusion.isDomainExcluded(link.host);
    if (isExcluded) {
      excluded += 1;
    }

    const result = await repo
      .createQueryBuilder()
      .insert()
      .into(CuratedLink)
      .values({
        url: link.url,
        urlHash: link.urlHash,
        host: link.host,
        groupLabel: link.groupLabel,
        // A blacklisted domain is stored but never processed — recording it (rather than
        // silently dropping the line) is what makes `curated:status` able to explain why the
        // pool has fewer processable links than the file has lines.
        status: isExcluded ? CuratedLinkStatus.EXCLUDED : CuratedLinkStatus.PENDING,
      })
      .orIgnore()
      .execute();

    if (result.identifiers?.[0]?.id) {
      inserted += 1;
    } else {
      alreadyKnown += 1;
    }
  }

  const byGroup = await repo
    .createQueryBuilder('c')
    .select('c.groupLabel', 'groupLabel')
    .addSelect('COUNT(*)', 'count')
    .groupBy('c.groupLabel')
    .orderBy('count', 'DESC')
    .getRawMany<{ groupLabel: string | null; count: string }>();

  console.log(
    `Импорт завершён: добавлено=${inserted}, уже было в базе=${alreadyKnown}, ` +
      `помечено excluded (EXCLUDED_DOMAINS)=${excluded}, всего в пуле=${await repo.count()}`,
  );
  console.log('По группам:');
  for (const row of byGroup) {
    console.log(`  ${row.groupLabel ?? '(без группы)'}: ${row.count}`);
  }

  await app.close();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
