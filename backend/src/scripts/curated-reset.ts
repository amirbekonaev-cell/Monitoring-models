/**
 * Returns the closed pool to its un-processed state — see CuratedResetService, which owns the
 * actual logic and is shared with the bot's /reset button so the two can't drift apart.
 *
 * DESTRUCTIVE: the deleted mentions include any sentiment already classified for them (a manual
 * tone correction made in the UI included — `sentiment_manual` does not survive the row being
 * deleted), and re-processing costs OpenAI calls again. Refuses to run without --yes.
 *
 * Usage:
 *   npm run curated:reset -- --yes
 *   npm run curated:reset -- --yes --hosts sknews.kz,bluescreen.kz   (only those hosts)
 */
import { CuratedResetService } from '../curated/curated-reset.service';
import { createCuratedScriptContext, describeDatabase, hasFlag, listFlag } from './curated-script-context';

async function main(): Promise<void> {
  const confirmed = hasFlag('yes');
  const hosts = listFlag('hosts');

  const app = await createCuratedScriptContext();
  const resetService = app.get(CuratedResetService);

  console.log(`База: ${describeDatabase()}`);

  const preview = await resetService.preview(hosts);
  if (preview.links === 0) {
    console.log('Под условие не попала ни одна ссылка — ничего не делаю.');
    await app.close();
    return;
  }

  const scope = hosts?.length ? `хостов ${hosts.join(', ')}` : 'всего пула';
  console.log(`Будет сброшено ссылок (${scope}): ${preview.links}`);
  console.log(`Будет удалено упоминаний, созданных этими ссылками: ${preview.mentions}`);

  if (!confirmed) {
    console.log(
      'Это необратимо (удалённые упоминания вместе с уже определённой тональностью не восстановить, ' +
        'повторная обработка снова потратит вызовы OpenAI). Запустите с --yes, чтобы выполнить.',
    );
    await app.close();
    return;
  }

  const outcome = await resetService.reset(hosts);
  console.log(`Готово. Удалено упоминаний: ${outcome.mentionsDeleted}. Ссылок возвращено в pending: ${outcome.links}.`);
  console.log('Дальше: `npm run curated:process` — или просто /search в боте, если CURATED_LAZY_PROCESS=true.');

  await app.close();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
