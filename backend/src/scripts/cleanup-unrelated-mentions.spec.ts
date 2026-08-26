import { containsFalsePositiveTerm, isBrandKeyword, FALSE_POSITIVE_TERMS } from './cleanup-unrelated-mentions';
import { KeywordType } from '../keywords/keyword.entity';

describe('cleanup-unrelated-mentions: containsFalsePositiveTerm', () => {
  it('matches the nominative form "Астана"', () => {
    expect(containsFalsePositiveTerm({ title: 'Погода в Астане', text: '' }, 'астан')).toBe(true);
  });

  it('matches Russian-declined forms that do not contain the full word "астана"', () => {
    // "Астаны" (genitive) and "Астане" (prepositional) both drop/replace the final "а" — this is
    // exactly why the stem "астан" is used instead of the full word "астана" (see the module
    // comment): a full-word substring check would silently miss both of these.
    expect(containsFalsePositiveTerm({ title: 'Житель Астаны', text: '' }, 'астан')).toBe(true);
    expect(containsFalsePositiveTerm({ title: '', text: 'Ремонт моста в Астане' }, 'астан')).toBe(true);
  });

  it('matches "медицинская"/"медицины" via the truncated "медицин" stem', () => {
    expect(containsFalsePositiveTerm({ title: 'Современная медицинская помощь', text: '' }, 'медицин')).toBe(true);
    expect(containsFalsePositiveTerm({ title: '', text: 'развитие медицины в стране' }, 'медицин')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(containsFalsePositiveTerm({ title: 'АСТАНА готовится к зиме', text: '' }, 'астан')).toBe(true);
  });

  it('does not match unrelated content', () => {
    expect(containsFalsePositiveTerm({ title: 'QazCloud открыл новый дата-центр', text: 'в Алматы' }, 'астан')).toBe(
      false,
    );
  });

  it('matches the English form "astana" — the Cyrillic stem does not cover Latin-script sources', () => {
    expect(containsFalsePositiveTerm({ title: 'astana_hub - Цифровой технопарк', text: '' }, 'astana')).toBe(true);
  });

  it('matches "medical"/"medication" via the truncated English "medic" stem', () => {
    expect(containsFalsePositiveTerm({ title: '', text: 'a new medical technology hub' }, 'medic')).toBe(true);
    expect(containsFalsePositiveTerm({ title: 'Free medication for students', text: '' }, 'medic')).toBe(true);
  });
});

describe('cleanup-unrelated-mentions: isBrandKeyword', () => {
  it('treats a REQUIRED brand keyword as a brand keyword', () => {
    expect(isBrandKeyword({ type: KeywordType.REQUIRED, phrase: 'QazCloud' }, FALSE_POSITIVE_TERMS)).toBe(true);
    expect(isBrandKeyword({ type: KeywordType.REQUIRED, phrase: 'Казклауд' }, FALSE_POSITIVE_TERMS)).toBe(true);
  });

  it('treats an EXACT_PHRASE keyword as a brand keyword too', () => {
    expect(isBrandKeyword({ type: KeywordType.EXACT_PHRASE, phrase: 'новый тариф QazCloud' }, FALSE_POSITIVE_TERMS)).toBe(
      true,
    );
  });

  it('excludes a REQUIRED "Астана" keyword — this project`s real data has exactly this row, and it is the root cause this script cleans up', () => {
    expect(isBrandKeyword({ type: KeywordType.REQUIRED, phrase: 'Астана' }, FALSE_POSITIVE_TERMS)).toBe(false);
  });

  it('excludes a MINUS keyword regardless of phrase (only REQUIRED/EXACT_PHRASE count as brand keywords)', () => {
    expect(isBrandKeyword({ type: KeywordType.MINUS, phrase: 'QazCloud' }, FALSE_POSITIVE_TERMS)).toBe(false);
  });
});
