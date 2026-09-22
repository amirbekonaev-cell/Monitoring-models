import { AppDataSource } from '../database/data-source';
import { Keyword, KeywordType } from '../keywords/keyword.entity';

/**
 * Every spelling of the company name this project is expected to recognise. Matching for a
 * keyword that carries manualForms is literal and case-insensitive (see ActiveKeywordSet), so
 * "КазКлауд"/"QAZCLOUD"/"qazcloud" are all covered by the base forms and need no entry of their
 * own — what DOES need an explicit entry is a different CHARACTER: the Kazakh "Қ" in "Қазклауд"
 * is not the Russian "К", so a text using it matches nothing without this form. Several of the
 * closed pool's articles are in Kazakh.
 */
const SEED_KEYWORDS: Array<{ phrase: string; type: KeywordType; language: string; manualForms: string[] }> = [
  // Cyrillic brand spelling — "Каз Клауд" covers the two-word variant some authors use,
  // "Қазклауд"/"Қаз Клауд" the Kazakh-alphabet spelling.
  {
    phrase: 'Казклауд',
    type: KeywordType.REQUIRED,
    language: 'ru',
    manualForms: ['Каз Клауд', 'Қазклауд', 'Қаз Клауд'],
  },
  // Latin brand spelling — "Qaz Cloud" covers the two-word variant.
  { phrase: 'QazCloud', type: KeywordType.REQUIRED, language: 'ru', manualForms: ['Qaz Cloud'] },
];

async function run(): Promise<void> {
  await AppDataSource.initialize();
  const repo = AppDataSource.getRepository(Keyword);

  for (const seed of SEED_KEYWORDS) {
    const existing = await repo.findOne({ where: { phrase: seed.phrase } });
    if (existing) {
      // Re-running the seed must be able to ADD a newly-needed spelling to a keyword that already
      // exists (this is how "Қазклауд" reaches a database seeded before it was listed) — but it
      // must never remove a form an operator added by hand through the keywords screen, so the
      // two lists are merged rather than overwritten.
      const merged = [...new Set([...(existing.manualForms ?? []), ...seed.manualForms])];
      if (merged.length !== (existing.manualForms ?? []).length) {
        await repo.update(existing.id, { manualForms: merged });
        console.log(`updated forms: ${seed.phrase} (${merged.join(', ')})`);
      } else {
        console.log(`skip (already exists): ${seed.phrase}`);
      }
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