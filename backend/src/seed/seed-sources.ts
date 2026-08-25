import { AppDataSource } from '../database/data-source';
import { Source, SourceKind, SourceStatus } from '../sources/source.entity';

const SEED_SOURCES: Array<{ name: string; url: string; type: SourceKind }> = [
  { name: 'Kazinform — новости', url: 'https://www.inform.kz/rss/ru.xml', type: SourceKind.RSS },
  { name: 'Caravan.kz', url: 'https://www.caravan.kz/rss/', type: SourceKind.RSS },
  {
    name: 'Sputnik Казахстан',
    url: 'https://ru.sputnik.kz/export/rss2/archive/index.xml',
    type: SourceKind.RSS,
  },
];

async function run(): Promise<void> {
  await AppDataSource.initialize();
  const repo = AppDataSource.getRepository(Source);

  for (const seed of SEED_SOURCES) {
    const existing = await repo.findOne({ where: { url: seed.url } });
    if (existing) {
      console.log(`skip (already exists): ${seed.url}`);
      continue;
    }
    await repo.save(
      repo.create({
        name: seed.name,
        url: seed.url,
        type: seed.type,
        status: SourceStatus.ACTIVE,
        createdBy: 'seed',
      }),
    );
    console.log(`added: ${seed.url}`);
  }

  await AppDataSource.destroy();
}

run().catch((error) => {
  console.error('Seed failed:', error);
  process.exit(1);
});