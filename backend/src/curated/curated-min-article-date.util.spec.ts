import { minArticleDateRejectionReason, parseCuratedMinArticleDate } from './curated-min-article-date.util';

describe('parseCuratedMinArticleDate', () => {
  it('parses a YYYY-MM-DD threshold as midnight UTC of that calendar day', () => {
    expect(parseCuratedMinArticleDate('2023-01-01')?.toISOString()).toBe('2023-01-01T00:00:00.000Z');
  });

  it('tolerates surrounding whitespace (a .env value pasted with a trailing space)', () => {
    expect(parseCuratedMinArticleDate('  2023-01-01 ')?.toISOString()).toBe('2023-01-01T00:00:00.000Z');
  });

  // Unset is the default and MUST mean "no cutoff": dropping old links is an editorial decision,
  // never something that happens because a variable was forgotten.
  it.each([undefined, '', '   '])('returns null (no cutoff) for %p', (raw) => {
    expect(parseCuratedMinArticleDate(raw)).toBeNull();
  });

  it.each([
    ['01.01.2023', 'a Russian-style date'],
    ['2023/01/01', 'slashes instead of dashes'],
    ['2023-1-1', 'unpadded month/day'],
    ['вчера', 'free text'],
    ['2023-13-01', 'month 13'],
    ['2023-02-31', 'a day that does not exist in that month'],
  ])('ignores %s (%s) instead of throwing', (raw) => {
    expect(parseCuratedMinArticleDate(raw)).toBeNull();
  });

  it('never throws on a malformed value — a typo must not stop the backend from booting', () => {
    expect(() => parseCuratedMinArticleDate('не дата')).not.toThrow();
  });
});

describe('minArticleDateRejectionReason', () => {
  it('names both dates and the variable, and carries no URL', () => {
    const reason = minArticleDateRejectionReason(new Date('2019-05-04T00:00:00Z'), new Date('2023-01-01T00:00:00Z'));

    expect(reason).toContain('статья старше порога CURATED_MIN_ARTICLE_DATE');
    expect(reason).toContain('2019-05-04');
    expect(reason).toContain('2023-01-01');
    expect(reason).not.toContain('http');
  });
});
