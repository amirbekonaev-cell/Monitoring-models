/**
 * Adds "Астана" и "медицина" as MINUS-keywords (KeywordType.MINUS) so ActiveKeywordSet
 * automatically excludes generic Astana-city / medicine-topic false positives from every future
 * collection cycle and /search run, instead of only being caught after the fact by
 * cleanup-unrelated-mentions.ts. See README "Очистка нерелевантных упоминаний".
 *
 * Idempotent by (phrase, type) — not just phrase like seed-keywords.ts — because `keywords` can
 * already contain an *active REQUIRED* "Астана" entry (see the warning this script prints below):
 * a phrase-only existence check would find that row and skip adding the MINUS one entirely.
 *
 * Forces literal-substring matching via `manualForms` (same technique the QazCloud/Казклауд brand
 * keywords already use — see seed-keywords.ts) instead of the default Postgres 'russian' FTS path,
 * because FTS turned out unreliable for exactly these two words on this project's real data:
 * `to_tsvector('russian', 'в Астане...') @@ plainto_tsquery('russian', 'Астана')` is false (misses
 * the prepositional case), and same for 'медицинская' against 'медицина' (misses the adjective
 * form). manualForms carries the truncated Cyrillic stem ("Астан"/"медицин", not the full word) —
 * matching cleanup-unrelated-mentions.ts's FALSE_POSITIVE_TERMS and the task's own "медицин%ловит
 * медицина/медицинский одним LIKE" hint — since Kazakh case suffixes append after the stem and
 * Russian declension of "Астана" only ever changes the final vowel, never the truncated stem. Also
 * carries an English form for each ("Astana"/"medic") — real collected data includes English-
 * language sources (e.g. astanahub.com, "Al-Sana in Kazakhstani universities"), and neither
 * Cyrillic stem matches Latin script at all. "Astana" doesn't decline in English, so no truncation
 * needed there; "medic" (not "medicine") is truncated the same way as the Cyrillic stem, to also
 * catch "medical"/"medication"/"biomedical".
 *
 * Idempotent on manualForms too, not just on the row's existence: an existing row is updated with
 * any form from MINUS_KEYWORDS it doesn't already have (e.g. re-running after English forms were
 * added here backfills them onto a row created by an earlier version of this script), rather than
 * silently skipping and leaving it stale.
 *
 * Usage: npm run seed:minus-keywords
 */
import { AppDataSource } from '../database/data-source';
import { Keyword, KeywordType } from '../keywords/keyword.entity';

const MINUS_KEYWORDS: Array<{ phrase: string; language: string; manualForms: string[] }> = [
  { phrase: 'Астана', language: 'ru', manualForms: ['Астан', 'Astana'] },
  { phrase: 'медицина', language: 'ru', manualForms: ['медицин', 'medic'] },
];

async function run(): Promise<void> {
  await AppDataSource.initialize();
  const repo = AppDataSource.getRepository(Keyword);

  for (const seed of MINUS_KEYWORDS) {
    const existing = await repo.findOne({ where: { phrase: seed.phrase, type: KeywordType.MINUS } });
    if (existing) {
      const missingForms = seed.manualForms.filter((form) => !existing.manualForms.includes(form));
      if (missingForms.length === 0) {
        console.log(`skip (already exists, forms up to date): ${seed.phrase} (minus)`);
        continue;
      }
      await repo.update(existing.id, { manualForms: [...existing.manualForms, ...missingForms] });
      console.log(`updated minus keyword: ${seed.phrase} (added forms: ${missingForms.join(', ')})`);
      continue;
    }
    await repo.save(
      repo.create({
        phrase: seed.phrase,
        type: KeywordType.MINUS,
        language: seed.language,
        manualForms: seed.manualForms,
        isActive: true,
      }),
    );
    console.log(`added minus keyword: ${seed.phrase}`);
  }

  // TypeORM ORs top-level array entries in `where` — this finds any active REQUIRED row whose
  // phrase equals either minus term just added.
  const conflicting = await repo.find({
    where: MINUS_KEYWORDS.map((k) => ({ phrase: k.phrase, type: KeywordType.REQUIRED, isActive: true })),
  });
  if (conflicting.length > 0) {
    console.warn(
      `\n⚠ Внимание: в keywords уже есть активный(е) REQUIRED-ключ(и) с той же фразой, что и ` +
        `у добавленных minus-слов: ${conflicting.map((k) => k.phrase).join(', ')}. Это, вероятно, и ` +
        'есть причина ложных срабатываний, которые чистит cleanup-unrelated-mentions.ts. MINUS ' +
        'всегда побеждает REQUIRED при совпадении (см. ActiveKeywordSet.match), так что новые ложные ' +
        'находки уже не появятся — но стоит вручную проверить и, если этот REQUIRED-ключ не нужен, ' +
        'деактивировать/удалить его через вкладку «Ключевые слова» в UI.',
    );
  }

  await AppDataSource.destroy();
}

run().catch((error) => {
  console.error('Seed (minus keywords) failed:', error);
  process.exit(1);
});
