/**
 * Processes the closed pool: reads each pending link's page, classifies it, writes the mention.
 * The same CuratedIngestService the lazy /search top-up uses — but without a Vercel request's
 * 60-second budget, so a full pool run can take as long as it needs.
 *
 * Usage:
 *   npm run curated:process -- [--limit N] [--concurrency N] [--force] [--retry-failed]
 *
 * Resumable: a link that reached `processed` is skipped on the next run (an OpenAI page read is
 * billed — we do not pay for the same page twice), so an interrupted run is continued simply by
 * running the command again. `--force` re-reads everything, `--retry-failed` gives up-to-date
 * links that exhausted their attempts a fresh set.
 *
 * Prints progress and a summary of counters only — never a URL (see README "Приватность").
 */
import { CuratedIngestService, ProcessLinkOutcome } from '../curated/curated-ingest.service';
import { CuratedOpenAiReaderService } from '../curated/curated-openai-reader.service';
import { CuratedLinkStatus } from '../curated/curated-link.entity';
import { createCuratedScriptContext, describeDatabase, hasFlag, numberFlag } from './curated-script-context';

async function main(): Promise<void> {
  const limit = numberFlag('limit');
  const concurrency = numberFlag('concurrency');
  const force = hasFlag('force');
  const retryFailed = hasFlag('retry-failed');

  const app = await createCuratedScriptContext();
  const ingest = app.get(CuratedIngestService);
  const reader = app.get(CuratedOpenAiReaderService);

  console.log(`База: ${describeDatabase()}`);
  console.log(`Режим чтения страниц: ${process.env.CURATED_READ_MODE || 'auto'}`);
  if (!reader.isConfigured()) {
    console.warn(
      'OPENAI_API_KEY не задан: страницы, которые не берёт HTTP-парсер, обработать не получится, ' +
        'а тональность останется "не определена".',
    );
  }

  const planned = await ingest.selectLinks({ limit, force, retryFailed });
  console.log(`К обработке: ${planned.length} ссыл(ок)${limit ? ` (лимит ${limit})` : ''}`);
  if (planned.length === 0) {
    await app.close();
    return;
  }

  const startedAt = Date.now();
  const summary = await ingest.processPending({
    limit,
    concurrency,
    force,
    retryFailed,
    onProgress: (done, total, outcome) => console.log(`[${done}/${total}] ${formatOutcome(outcome)}`),
  });
  const elapsedSec = Math.round((Date.now() - startedAt) / 1000);

  console.log('');
  console.log(`Готово за ${elapsedSec} с. Обработано ссылок: ${summary.attempted}`);
  console.log(`  прочитано HTTP-парсером: ${summary.readByParser}`);
  console.log(`  прочитано через OpenAI:  ${summary.readByOpenAi}`);
  console.log(`  вызовов web_search:      ${summary.webSearchCalls}`);
  console.log(`  вызовов тональности:     ${summary.sentimentCalls}`);
  console.log(`  статусы: ${formatRecord(summary.byStatus)}`);
  console.log(`  тональности: ${formatRecord(summary.bySentiment)}`);

  const dated = summary.withDate + summary.withoutDate;
  const datedShare = dated > 0 ? Math.round((summary.withDate / dated) * 100) : 0;
  console.log(`  с датой публикации: ${summary.withDate}/${dated} (${datedShare}%), источники даты: ${formatRecord(summary.byDateSource)}`);

  const poolTotals = await ingest.countByStatus();
  console.log(`Весь пул после прогона: ${formatRecord(poolTotals)}`);

  await app.close();
}

function formatOutcome(outcome: ProcessLinkOutcome): string {
  const via = outcome.readVia ? ` (${outcome.readVia})` : '';
  const tone = outcome.sentiment ? ` · ${outcome.sentiment}` : '';
  const date = outcome.dateSource ? ` · дата: ${outcome.dateSource}` : ' · без даты';
  const error = outcome.error ? ` · ${outcome.error}` : '';
  const flagged = outcome.status === CuratedLinkStatus.PROCESSED ? '' : ' !';
  return `${outcome.status}${flagged}${via}${tone}${date}${error}`;
}

function formatRecord(record: Record<string, number>): string {
  return (
    Object.entries(record)
      .filter(([, count]) => count > 0)
      .map(([key, count]) => `${key}=${count}`)
      .join(', ') || 'пусто'
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
