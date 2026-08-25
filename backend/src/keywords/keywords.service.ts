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

/**
 * Matching rules:
 * - No active required/exact_phrase keywords at all -> everything passes (unfiltered feed,
 *   same behaviour as before keywords existed).
 * - Otherwise an item must match at least one active required/exact_phrase keyword (OR),
 *   and must not match any active minus keyword.
 * - 'exact_phrase' keywords always match as a literal case-insensitive substring.
 * - 'required'/'minus' keywords with language='kk' or explicit manualForms match against
 *   [phrase, ...manualForms] as literal substrings (Postgres has no Kazakh FTS dictionary).
 * - 'required'/'minus' keywords with language='ru' (default) and no manualForms match via
 *   Postgres full-text search (to_tsvector('russian', ...) @@ plainto_tsquery(...)), which
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

  private literalMatch(haystack: string, keyword: Keyword): boolean {
    const lower = haystack.toLowerCase();
    const forms = [keyword.phrase, ...(keyword.manualForms ?? [])];
    return forms.some((form) => form.trim() && lower.includes(form.trim().toLowerCase()));
  }

  private async ruFtsMatch(haystack: string, phrases: string[]): Promise<boolean[]> {
    if (phrases.length === 0) {
      return [];
    }
    const rows: Array<{ idx: number; matched: boolean | string }> = await this.dataSource.query(
      `SELECT ord - 1 as idx, to_tsvector('russian', $1) @@ plainto_tsquery('russian', kw) as matched
       FROM unnest($2::text[]) WITH ORDINALITY AS t(kw, ord)`,
      [haystack, phrases],
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

    // Split ru-FTS-eligible keywords out so we can batch them into one query.
    const ruEligible = (type: KeywordType) =>
      this.keywords.filter((k) => k.type === type && !this.usesManualForms(k));
    const ruRequired = ruEligible(KeywordType.REQUIRED);
    const ruMinus = ruEligible(KeywordType.MINUS);

    const [ruRequiredMatches, ruMinusMatches] = await Promise.all([
      this.ruFtsMatch(
        haystack,
        ruRequired.map((k) => k.phrase),
      ),
      this.ruFtsMatch(
        haystack,
        ruMinus.map((k) => k.phrase),
      ),
    ]);

    let positiveMatched = false;

    ruRequired.forEach((k, i) => {
      if (ruRequiredMatches[i]) {
        positiveMatched = true;
        matchedKeywords.push(k.phrase);
      }
    });

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
    ruMinus.forEach((k, i) => {
      if (ruMinusMatches[i]) {
        minusMatched = true;
      }
    });
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
