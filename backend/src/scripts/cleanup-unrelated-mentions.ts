/**
 * One-off maintenance script: removes mentions that don't actually belong in the database —
 * (a) rows that don't relate to QazCloud at all (don't match any active REQUIRED/EXACT_PHRASE
 * keyword), and (b) rows that are false positives on the generic words "Астана"/"медицина" (the
 * city name and the medical topic, both unrelated to the company). See README "Очистка
 * нерелевантных упоминаний".
 *
 * Dry-run by default — prints counts and a few examples per reason, deletes nothing. Pass
 * --execute to actually delete. --dry-run is accepted explicitly too but is the default anyway.
 *
 * Usage: npm run cleanup-mentions [-- --execute]
 * (from backend/, or via `docker compose run --rm migrate npm run cleanup-mentions -- --execute`
 * so it shares the real Postgres — plain host runs won't resolve the `postgres` hostname from .env)
 */
import 'reflect-metadata';
import { AppDataSource } from '../database/data-source';
import { Mention } from '../mentions/mention.entity';
import { Keyword, KeywordType } from '../keywords/keyword.entity';
import { ActiveKeywordSet } from '../keywords/keywords.service';

const SAMPLE_SIZE = 5;

// Substrings for reason (b) — deliberately not a Kazakh/Russian morphology lookup, just a
// truncated stem for each word (same "медицин%"-style principle for both, not full-word
// "медицина"/"астана"): Kazakh case suffixes append after the stem without altering it
// (Астана -> Астананың/Астанада/...), but Russian declension of "Астана" *replaces* the final
// vowel (Астана -> Астаны/Астане/Астаной/астанчанин/...) — matching on the full word "астана"
// silently misses every one of those Russian-declined forms. Verified against this project's real
// data: the full word "%астана%" catches 51 rows; the truncated stem "%астан%" below catches 102 —
// every one of the extra 51 checked manually and is a genuine Astana-city false positive (traffic,
// weather, elections, the Astana cycling team, astana_hub, Astana.kz), none of them QazCloud.
//
// Also includes an English form of each — neither Cyrillic stem matches Latin script at all, and
// production has real English-language false positives ("astana_hub", "Al-Sana in Kazakhstani
// universities" whose text mentions "medicine"/"medical"). "Astana" doesn't decline in English, so
// no truncation needed; "medic" (not "medicine") is truncated the same way, to also catch
// "medical"/"medication"/"biomedical". Matches the manualForms seeded onto the MINUS keywords in
// seed-minus-keywords.ts — keep the two in sync.
export const FALSE_POSITIVE_TERMS = ['астан', 'медицин', 'astana', 'medic'];

export function containsFalsePositiveTerm(mention: Pick<Mention, 'title' | 'text'>, term: string): boolean {
  const haystack = `${mention.title}\n${mention.text}`.toLowerCase();
  return haystack.includes(term);
}

/**
 * True for an active REQUIRED/EXACT_PHRASE keyword that genuinely identifies the QazCloud brand
 * (used to decide what counts as "brand-only" below) — false for one whose phrase is itself one
 * of the false-positive terms this script cleans up (see the active REQUIRED "Астана" keyword
 * this project's real `keywords` table already had — that's almost certainly the actual root
 * cause of the Astana-city false positives, and treating it as a legitimate brand identifier
 * would defeat this whole script).
 */
export function isBrandKeyword(keyword: Pick<Keyword, 'type' | 'phrase'>, falsePositiveTerms: string[]): boolean {
  return (
    (keyword.type === KeywordType.REQUIRED || keyword.type === KeywordType.EXACT_PHRASE) &&
    !falsePositiveTerms.some((term) => keyword.phrase.trim().toLowerCase().includes(term))
  );
}

async function main(): Promise<void> {
  const execute = process.argv.includes('--execute');

  await AppDataSource.initialize();
  const mentionsRepo = AppDataSource.getRepository(Mention);
  const keywordRepo = AppDataSource.getRepository(Keyword);

  const activeKeywords = await keywordRepo.find({ where: { isActive: true } });
  // Same matcher the real collector/on-demand /search use — not a hardcoded "qazcloud"/"казклауд"
  // string, so this can never drift from what actually counts as relevant right now.
  const keywordSet = new ActiveKeywordSet(activeKeywords, AppDataSource);

  // "Brand-only" keywords: active REQUIRED/EXACT_PHRASE keywords whose phrase isn't itself one of
  // the false-positive terms being cleaned up here. Used below to protect genuinely relevant rows
  // from *both* deletion reasons. This matters concretely for this database: `keywords` currently
  // has (or, after step 2.2, may end up next to) an active REQUIRED "Астана" entry — almost
  // certainly the actual root cause of the Astana-city false positives — and including that in the
  // relevance check would make every Astana-mentioning row look "relevant to QazCloud".
  const brandKeywords = activeKeywords.filter((k) => isBrandKeyword(k, FALSE_POSITIVE_TERMS));
  const brandKeywordSet = new ActiveKeywordSet(brandKeywords, AppDataSource);

  const allMentions = await mentionsRepo.find();
  console.log(`Всего упоминаний в базе: ${allMentions.length}`);

  const unrelatedIds = new Set<string>();
  const unrelatedSamples: Array<{ title: string; url: string }> = [];
  const falsePositiveIds = new Set<string>();
  const falsePositiveSamplesByTerm = new Map<string, Array<{ title: string; url: string }>>(
    FALSE_POSITIVE_TERMS.map((term) => [term, []]),
  );
  const protectedSamples: Array<{ title: string; url: string }> = [];

  // Single pass per mention, brand relevance checked *before* either deletion reason. Why this
  // order matters: once "Астана"/"медицина" become active MINUS keywords (step 2.2), the *full*
  // active keyword set that reason (a) would otherwise use directly starts returning
  // matched:false for every row containing them — including a genuinely relevant one (e.g. "ТОО
  // QAZCLOUD (КАЗКЛАУД), Г.АСТАНА", a real company record that also names its home city), because
  // a MINUS match always overrides a positive match (see ActiveKeywordSet.match). Checking brand
  // relevance first, independently of reason (a)/(b), keeps that row safe regardless of whether
  // this script runs before or after the minus keywords are seeded.
  for (const mention of allMentions) {
    // No brand keyword left to check against (e.g. all removed by an admin) -> nothing can be
    // independently confirmed relevant, so don't protect anything on that basis.
    const isBrandRelevant =
      brandKeywords.length > 0 && (await brandKeywordSet.match(mention.title, mention.text)).matched;
    if (isBrandRelevant) {
      const matchedTerms = FALSE_POSITIVE_TERMS.filter((term) => containsFalsePositiveTerm(mention, term));
      if (matchedTerms.length > 0 && protectedSamples.length < SAMPLE_SIZE) {
        protectedSamples.push({ title: mention.title, url: mention.url });
      }
      continue;
    }

    // Reason (a): doesn't match any active REQUIRED/EXACT_PHRASE keyword at all (never true for
    // the protected row above, since that path already continued).
    const { matched } = await keywordSet.match(mention.title, mention.text);
    if (!matched) {
      unrelatedIds.add(mention.id);
      if (unrelatedSamples.length < SAMPLE_SIZE) {
        unrelatedSamples.push({ title: mention.title, url: mention.url });
      }
    }

    // Reason (b): "Астана"/"медицин" false positives.
    const matchedTerms = FALSE_POSITIVE_TERMS.filter((term) => containsFalsePositiveTerm(mention, term));
    if (matchedTerms.length > 0) {
      falsePositiveIds.add(mention.id);
      for (const term of matchedTerms) {
        const samples = falsePositiveSamplesByTerm.get(term)!;
        if (samples.length < SAMPLE_SIZE) {
          samples.push({ title: mention.title, url: mention.url });
        }
      }
    }
  }

  console.log(`\nПричина (а) — не связаны с QazCloud вообще: ${unrelatedIds.size}`);
  for (const sample of unrelatedSamples) {
    console.log(`  - ${sample.title}\n    ${sample.url}`);
  }

  console.log(`\nПричина (б) — ложные срабатывания "Астана"/"медицина": ${falsePositiveIds.size}`);
  for (const term of FALSE_POSITIVE_TERMS) {
    const samples = falsePositiveSamplesByTerm.get(term)!;
    console.log(`  "${term}" — примеры:`);
    for (const sample of samples) {
      console.log(`    - ${sample.title}\n      ${sample.url}`);
    }
  }
  if (protectedSamples.length > 0) {
    console.log(
      `\nЗащищены от удаления (содержат "Астана"/"медицина", но независимо подтверждены как ` +
        `релевантные QazCloud по реальному бренд-ключу) — примеры:`,
    );
    for (const sample of protectedSamples) {
      console.log(`  - ${sample.title}\n    ${sample.url}`);
    }
  }

  const toDeleteIds = new Set<string>([...unrelatedIds, ...falsePositiveIds]);
  console.log(`\nВсего уникальных записей под удаление (а ∪ б): ${toDeleteIds.size}`);

  if (!execute) {
    console.log('\nDry-run: ничего не удалено. Запустите с флагом --execute, чтобы удалить.');
    await AppDataSource.destroy();
    return;
  }

  if (toDeleteIds.size === 0) {
    console.log('\nНечего удалять.');
    await AppDataSource.destroy();
    return;
  }

  // Deliberately does NOT exclude sentiment_manual = true rows: sentiment_manual only records
  // that a human edited the *tone* classification (ФТ-11, see MentionsService.updateSentimentManually)
  // — it says nothing about whether the mention is actually relevant to QazCloud. Nothing in the
  // task requirements ties manual sentiment edits to relevance, so a manually-tagged row that's
  // genuinely unrelated (or an Astana/medicine false positive) is still deleted here.
  const result = await mentionsRepo
    .createQueryBuilder()
    .delete()
    .from(Mention)
    .whereInIds([...toDeleteIds])
    .execute();

  console.log(`\nУдалено записей: ${result.affected ?? 0}`);
  await AppDataSource.destroy();
}

// Guarded so cleanup-unrelated-mentions.spec.ts can import the pure helpers above without also
// triggering a live AppDataSource connection attempt as a side effect of the import.
if (require.main === module) {
  main().catch((error) => {
    console.error('Очистка не удалась:', error);
    process.exit(1);
  });
}
