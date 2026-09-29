/**
 * Returns the closed pool to its un-processed state: every link back to `pending`, and the
 * mentions those links produced deleted. Nothing about the link list itself is lost — the URLs,
 * hosts and group labels stay exactly as imported, so the next `curated:process` (or the bot's
 * own CURATED_LAZY_PROCESS pass) reads them again from scratch.
 *
 * Why this exists: pool mentions are what the feed/dashboard and /search actually show, so a
 * fully processed pool means every link is already visible before anyone asks for anything. For
 * a stand where the links should surface as the bot works through them, the pool has to start
 * un-processed.
 *
 * DESTRUCTIVE: the deleted mentions include any sentiment already classified for them (a manual
 * tone correction made in the UI included — `sentiment_manual` does not survive the row being
 * deleted). Re-processing will re-download and re-classify, which costs OpenAI calls again.
 * Because of that it refuses to run without --yes, and never touches a mention that did not come
 * from the pool (`curated_link_id IS NULL` — everything collected by RSS/parser/onboarding is
 * left alone).
 *
 * Usage:
 *   npm run curated:reset -- --yes
 *   npm run curated:reset -- --yes --hosts sknews.kz,bluescreen.kz   (only those hosts)
 */
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CuratedLink, CuratedLinkStatus } from '../curated/curated-link.entity';
import { Mention } from '../mentions/mention.entity';
import { createCuratedScriptContext, describeDatabase, hasFlag, listFlag } from './curated-script-context';

async function main(): Promise<void> {
  const confirmed = hasFlag('yes');
  const hosts = listFlag('hosts');

  const app = await createCuratedScriptContext();
  const linksRepo = app.get<Repository<CuratedLink>>(getRepositoryToken(CuratedLink));
  const mentionsRepo = app.get<Repository<Mention>>(getRepositoryToken(Mention));

  console.log(`База: ${describeDatabase()}`);

  const linkQuery = linksRepo.createQueryBuilder('c');
  if (hosts?.length) {
    linkQuery.where('c.host IN (:...hosts)', { hosts });
  }
  const links = await linkQuery.getMany();

  if (links.length === 0) {
    console.log('Под условие не попала ни одна ссылка — ничего не делаю.');
    await app.close();
    return;
  }

  const linkIds = links.map((link) => link.id);
  const mentionsToDelete = await mentionsRepo
    .createQueryBuilder('m')
    .where('m.curatedLinkId IN (:...linkIds)', { linkIds })
    .getCount();

  const scope = hosts?.length ? `хостов ${hosts.join(', ')}` : 'всего пула';
  console.log(`Будет сброшено ссылок (${scope}): ${links.length}`);
  console.log(`Будет удалено упоминаний, созданных этими ссылками: ${mentionsToDelete}`);

  if (!confirmed) {
    console.log(
      'Это необратимо (удалённые упоминания вместе с уже определённой тональностью не восстановить, ' +
        'повторная обработка снова потратит вызовы OpenAI). Запустите с --yes, чтобы выполнить.',
    );
    await app.close();
    return;
  }

  // Mentions first: a link row flipped to `pending` while its mention still exists would be
  // re-processed into the update branch of CuratedIngestService (refresh existing mention)
  // instead of a clean insert, which is not what "reset" should mean.
  const deleted = await mentionsRepo
    .createQueryBuilder()
    .delete()
    .from(Mention)
    .where('curated_link_id IN (:...linkIds)', { linkIds })
    .execute();

  await linksRepo
    .createQueryBuilder()
    .update(CuratedLink)
    .set({
      status: CuratedLinkStatus.PENDING,
      attempts: 0,
      lastError: null,
      processedAt: null,
      mentionId: null,
    })
    .where('id IN (:...linkIds)', { linkIds })
    .execute();

  console.log(`Готово. Удалено упоминаний: ${deleted.affected ?? 0}. Ссылок возвращено в pending: ${links.length}.`);
  console.log('Дальше: `npm run curated:process` — или просто /search в боте, если CURATED_LAZY_PROCESS=true.');

  await app.close();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
