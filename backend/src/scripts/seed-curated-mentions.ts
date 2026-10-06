import { AppDataSource } from '../database/data-source';
import { hashMentionText } from '../common/hash.util';
import { Mention, MentionSourceType } from '../mentions/mention.entity';
import { Source, SourceKind, SourceStatus } from '../sources/source.entity';
import { CURATED_MENTIONS, CURATED_SENTIMENT_TO_ENUM, normalizeUrl } from '../curated/curated-mentions';

/**
 * Загружает 168 готовых карточек упоминаний в таблицу mentions.
 *
 * Запуск:
 *   npm run seed:curated           — добавить недостающие, существующие пропустить
 *   npm run seed:curated -- --force — ещё и перезаписать текст/дату/тональность у уже залитых
 *
 * Важно:
 *  - sentimentManual = true  → фоновый классификатор не перетрёт ручную тональность;
 *  - notificationSent = true → при первом запуске бот не вывалит 168 алертов в чат разом;
 *  - isBackfill = true       → карточки помечены как историческая догрузка, а не свежие находки.
 */

const FORCE = process.argv.includes('--force');
const KEYWORDS = ['QazCloud'];

async function resolveSource(domain: string, name: string): Promise<Source> {
  const repo = AppDataSource.getRepository(Source);
  const all = await repo.find();
  const existing = all.find((s) => normalizeUrl(s.url).startsWith(domain));
  if (existing) return existing;

  return repo.save(
    repo.create({
      name,
      url: `https://${domain}/`,
      type: SourceKind.PARSER,
      status: SourceStatus.ACTIVE,
      createdBy: 'seed-curated',
    }),
  );
}

async function run(): Promise<void> {
  await AppDataSource.initialize();
  const mentions = AppDataSource.getRepository(Mention);

  const sourceCache = new Map<string, Source>();
  let added = 0;
  let updated = 0;
  let skipped = 0;

  for (const item of CURATED_MENTIONS) {
    let source = sourceCache.get(item.sourceDomain);
    if (!source) {
      source = await resolveSource(item.sourceDomain, item.sourceName);
      sourceCache.set(item.sourceDomain, source);
    }

    const payload = {
      title: item.title,
      text: item.summary,
      url: item.url,
      publishedAt: item.publishedAt ? new Date(`${item.publishedAt}T00:00:00+06:00`) : null,
      sourceId: source.id,
      sourceType: MentionSourceType.NEWS,
      language: 'ru',
      sentiment: CURATED_SENTIMENT_TO_ENUM[item.sentiment],
      sentimentManual: true,
      summary: item.summary,
      hash: hashMentionText(item.title, item.summary),
      keywords: KEYWORDS,
      notificationSent: true,
      isBackfill: true,
    };

    const existing = await mentions.findOne({ where: { url: item.url } });
    if (existing) {
      if (!FORCE) {
        skipped += 1;
        continue;
      }
      await mentions.save({ ...existing, ...payload });
      updated += 1;
      console.log(`обновлено [${item.id}] ${item.url}`);
      continue;
    }

    await mentions.save(mentions.create(payload));
    added += 1;
    console.log(`добавлено [${item.id}] ${item.url}`);
  }

  console.log(`\nИтого: добавлено ${added}, обновлено ${updated}, пропущено ${skipped}.`);
  await AppDataSource.destroy();
}

run().catch((error) => {
  console.error('seed:curated упал:', error);
  process.exit(1);
});
