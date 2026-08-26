import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { Keyword, KeywordType } from './keyword.entity';

export interface KeywordMatch {
  /** false only when there are active required/exact_phrase keywords and none matched. */
  matched: boolean;
  matchedKeywords: string[];
}

export interface UpsertKeywordInput {
  phrase: string;
  type: KeywordType;
  language?: string;
  manualForms?: string[];
  isActive?: boolean;
}

@Injectable()
export class KeywordsService {
  constructor(
    @InjectRepository(Keyword)
    private readonly keywordsRepo: Repository<Keyword>,
    private readonly dataSource: DataSource,
  ) {}

  findAll(): Promise<Keyword[]> {
    return this.keywordsRepo.find({ order: { createdAt: 'DESC' } });
  }

  create(input: UpsertKeywordInput): Promise<Keyword> {
    return this.keywordsRepo.save(
      this.keywordsRepo.create({
        phrase: input.phrase.trim(),
        type: input.type,
        language: input.language ?? 'ru',
        manualForms: input.manualForms ?? [],
        isActive: input.isActive ?? true,
      }),
    );
  }

  async update(id: string, input: Partial<UpsertKeywordInput>): Promise<Keyword | null> {
    await this.keywordsRepo.update(id, {
      ...(input.phrase !== undefined ? { phrase: input.phrase.trim() } : {}),
      ...(input.type !== undefined ? { type: input.type } : {}),
      ...(input.language !== undefined ? { language: input.language } : {}),
      ...(input.manualForms !== undefined ? { manualForms: input.manualForms } : {}),
      ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
    });
    return this.keywordsRepo.findOne({ where: { id } });
  }

  async remove(id: string): Promise<void> {
    await this.keywordsRepo.delete(id);
  }

  /**
   * Snapshot of active keywords for one collection cycle. Loading this once per cycle
   * (rather than per-item) is what makes "changes apply only to the next cycle" true —
   * a cycle already in progress keeps using the list it started with.
   */
  async loadActiveKeywordSet(): Promise<ActiveKeywordSet> {
    const active = await this.keywordsRepo.find({ where: { isActive: true } });
    return new ActiveKeywordSet(active, this.dataSource);
  }
}

type FtsConfig = 'russian' | 'english';

/**
 * Matching rules:
 * - No active required/exact_phrase keywords at all -> everything passes (unfiltered feed,
 *   same behaviour as before keywords existed).
 * - Otherwise an item must match at least one active required/exact_phrase keyword (OR),
 *   and must not match any active minus keyword.
 * - 'exact_phrase' keywords always match as a literal case-insensitive substring.
 * - 'required'/'minus' keywords with language='kk' or explicit manualForms match against
 *   [phrase, ...manualForms] as literal substrings (Postgres has no Kazakh FTS dictionary).
 * - 'required'/'minus' keywords with language='en' and no manualForms match via Postgres
 *   full-text search using the 'english' config (to_tsvector('english', ...)), which handles
 *   English word forms (plurals, basic suffixes) via the Porter stemmer.
 * - 'required'/'minus' keywords with language='ru' (default, or anything other than 'kk'/'en')
 *   and no manualForms match via Postgres full-text search using the 'russian' config, which
 *   handles Russian word forms/declensions automatically.
 */
export class ActiveKeywordSet {
  readonly hasPositiveKeywords: boolean;

  constructor(
    private readonly keywords: Keyword[],
    private readonly dataSource: DataSource,
  ) {
    this.hasPositiveKeywords = keywords.some(
      (k) => k.type === KeywordType.REQUIRED || k.type === KeywordType.EXACT_PHRASE,
    );
  }

  private usesManualForms(keyword: Keyword): boolean {
    return keyword.language === 'kk' || (keyword.manualForms?.length ?? 0) > 0;
  }

  private ftsConfigFor(keyword: Keyword): FtsConfig {
    return keyword.language === 'en' ? 'english' : 'russian';
  }

  private literalMatch(haystack: string, keyword: Keyword): boolean {
    const lower = haystack.toLowerCase();
    const forms = [keyword.phrase, ...(keyword.manualForms ?? [])];
    return forms.some((form) => form.trim() && lower.includes(form.trim().toLowerCase()));
  }

  private async ftsMatch(haystack: string, phrases: string[], config: FtsConfig): Promise<boolean[]> {
    if (phrases.length === 0) {
      return [];
    }
    const rows: Array<{ idx: number; matched: boolean | string }> = await this.dataSource.query(
      `SELECT ord - 1 as idx, to_tsvector($1::regconfig, $2) @@ plainto_tsquery($1::regconfig, kw) as matched
       FROM unnest($3::text[]) WITH ORDINALITY AS t(kw, ord)`,
      [config, haystack, phrases],
    );
    const result = new Array(phrases.length).fill(false);
    for (const row of rows) {
      result[Number(row.idx)] = (row.matched as unknown) === true || (row.matched as unknown) === 't';
    }
    return result;
  }

  async match(title: string, text: string): Promise<KeywordMatch> {
    const haystack = `${title}\n${text}`;
    const matchedKeywords: string[] = [];

    // Split fts-eligible keywords out (by type and by fts config) so each config can be batched
    // into a single query.
    const ftsEligible = (type: KeywordType, config: FtsConfig) =>
      this.keywords.filter((k) => k.type === type && !this.usesManualForms(k) && this.ftsConfigFor(k) === config);
    const ruRequired = ftsEligible(KeywordType.REQUIRED, 'russian');
    const enRequired = ftsEligible(KeywordType.REQUIRED, 'english');
    const ruMinus = ftsEligible(KeywordType.MINUS, 'russian');
    const enMinus = ftsEligible(KeywordType.MINUS, 'english');

    const [ruRequiredMatches, enRequiredMatches, ruMinusMatches, enMinusMatches] = await Promise.all([
      this.ftsMatch(
        haystack,
        ruRequired.map((k) => k.phrase),
        'russian',
      ),
      this.ftsMatch(
        haystack,
        enRequired.map((k) => k.phrase),
        'english',
      ),
      this.ftsMatch(
        haystack,
        ruMinus.map((k) => k.phrase),
        'russian',
      ),
      this.ftsMatch(
        haystack,
        enMinus.map((k) => k.phrase),
        'english',
      ),
    ]);

    let positiveMatched = false;

    const applyRequiredFtsMatches = (group: Keyword[], matches: boolean[]) => {
      group.forEach((k, i) => {
        if (matches[i]) {
          positiveMatched = true;
          matchedKeywords.push(k.phrase);
        }
      });
    };
    applyRequiredFtsMatches(ruRequired, ruRequiredMatches);
    applyRequiredFtsMatches(enRequired, enRequiredMatches);

    for (const k of this.keywords) {
      if (k.type === KeywordType.REQUIRED && this.usesManualForms(k)) {
        if (this.literalMatch(haystack, k)) {
          positiveMatched = true;
          matchedKeywords.push(k.phrase);
        }
      }
      if (k.type === KeywordType.EXACT_PHRASE) {
        if (this.literalMatch(haystack, k)) {
          positiveMatched = true;
          matchedKeywords.push(k.phrase);
        }
      }
    }

    let minusMatched = false;
    const applyMinusFtsMatches = (group: Keyword[], matches: boolean[]) => {
      group.forEach((k, i) => {
        if (matches[i]) {
          minusMatched = true;
        }
      });
    };
    applyMinusFtsMatches(ruMinus, ruMinusMatches);
    applyMinusFtsMatches(enMinus, enMinusMatches);

    for (const k of this.keywords) {
      if (k.type === KeywordType.MINUS && this.usesManualForms(k) && this.literalMatch(haystack, k)) {
        minusMatched = true;
      }
    }

    if (minusMatched) {
      return { matched: false, matchedKeywords: [] };
    }

    if (!this.hasPositiveKeywords) {
      return { matched: true, matchedKeywords: [] };
    }

    return { matched: positiveMatched, matchedKeywords };
  }
}