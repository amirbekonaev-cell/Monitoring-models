import { AppDataSource } from '../database/data-source';
import { Keyword, KeywordType } from '../keywords/keyword.entity';

const SEED_KEYWORDS: Array<{ phrase: string; type: KeywordType; language: string; manualForms: string[] }> = [
  // Cyrillic brand spelling — "Каз Клауд" covers the two-word variant some authors use.
  { phrase: 'Казклауд', type: KeywordType.REQUIRED, language: 'ru', manualForms: ['Каз Клауд'] },
  // Latin brand spelling — "Qaz Cloud" covers the two-word variant.
  { phrase: 'QazCloud', type: KeywordType.REQUIRED, language: 'ru', manualForms: ['Qaz Cloud'] },
];

async function run(): Promise<void> {
  await AppDataSource.initialize();
  const repo = AppDataSource.getRepository(Keyword);

  for (const seed of SEED_KEYWORDS) {
    const existing = await repo.findOne({ where: { phrase: seed.phrase } });
    if (existing) {
      console.log(`skip (already exists): ${seed.phrase}`);
      continue;
    }
    await repo.save(
      repo.create({
        phrase: seed.phrase,
        type: seed.type,
        language: seed.language,
        manualForms: seed.manualForms,
        isActive: true,
      }),
    );
    console.log(`added keyword: ${seed.phrase} (forms: ${seed.manualForms.join(', ')})`);
  }

  await AppDataSource.destroy();
}

run().catch((error) => {
  console.error('Seed failed:', error);
  process.exit(1);
});