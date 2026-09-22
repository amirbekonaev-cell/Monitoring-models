import { extractDateFromUrl, isPlausibleArticleDate, parseIsoDate, resolveArticleDate } from './curated-article-date.util';

const NOW = new Date('2026-09-22T12:00:00Z');

describe('extractDateFromUrl', () => {
  it('reads YYYY-MM-DD from a path segment', () => {
    expect(extractDateFromUrl('https://example.com/2026-04-20/slug', NOW)).toEqual(new Date(Date.UTC(2026, 3, 20)));
  });

  it('reads YYYY-MM-DD embedded at the start of a slug', () => {
    expect(extractDateFromUrl('https://example.com/2026-04-21-some-article-title/', NOW)).toEqual(
      new Date(Date.UTC(2026, 3, 21)),
    );
  });

  it('reads a compact YYYYMMDD path segment', () => {
    expect(extractDateFromUrl('https://example.com/20260803/slug-65434810.html', NOW)).toEqual(
      new Date(Date.UTC(2026, 7, 3)),
    );
  });

  it('reads DD-MM-YYYY, told apart from YYYY-MM-DD by which end holds the year', () => {
    expect(extractDateFromUrl('https://example.com/bilim/some-slug-22-05-2026', NOW)).toEqual(
      new Date(Date.UTC(2026, 4, 22)),
    );
  });

  it('reads YYYY/MM with no day as the first of that month', () => {
    expect(extractDateFromUrl('https://example.com/2023/08/slug', NOW)).toEqual(new Date(Date.UTC(2023, 7, 1)));
  });

  it('ignores an 8-digit article id that is not a plausible date', () => {
    // A numeric id is the single most common false positive in this pool's URLs.
    expect(extractDateFromUrl('https://example.com/news/65434810.html', NOW)).toBeNull();
    expect(extractDateFromUrl('https://example.com/17977920/', NOW)).toBeNull();
  });

  it('ignores a bare year in a slug', () => {
    expect(extractDateFromUrl('https://example.com/summit-2023-announced/', NOW)).toBeNull();
  });

  it('ignores digits in the hostname', () => {
    expect(extractDateFromUrl('https://20260803.example.com/slug', NOW)).toBeNull();
  });

  it('never rolls an impossible day over into the next month', () => {
    // 2023-02-31 would silently become 2023-03-03 under plain Date arithmetic. The day is
    // rejected; the year/month in the URL are still trustworthy, so it degrades to month
    // precision rather than to nothing.
    expect(extractDateFromUrl('https://example.com/2023-02-31/slug', NOW)).toEqual(new Date(Date.UTC(2023, 1, 1)));
  });

  it('returns null for a URL with no date and for a malformed URL', () => {
    expect(extractDateFromUrl('https://example.com/news/view/some-slug', NOW)).toBeNull();
    expect(extractDateFromUrl('not a url', NOW)).toBeNull();
  });
});

describe('isPlausibleArticleDate', () => {
  it('accepts a date inside [2000-01-01, tomorrow]', () => {
    expect(isPlausibleArticleDate(new Date('2023-08-02T00:00:00Z'), NOW)).toBe(true);
    expect(isPlausibleArticleDate(new Date('2026-09-22T23:00:00Z'), NOW)).toBe(true);
  });

  it('accepts tomorrow (a publisher in +05/+06 can legitimately be ahead of UTC)', () => {
    expect(isPlausibleArticleDate(new Date('2026-09-23T06:00:00Z'), NOW)).toBe(true);
  });

  it('rejects anything further in the future', () => {
    expect(isPlausibleArticleDate(new Date('2027-01-01T00:00:00Z'), NOW)).toBe(false);
  });

  it('rejects anything before 2000', () => {
    expect(isPlausibleArticleDate(new Date('1997-05-05T00:00:00Z'), NOW)).toBe(false);
  });

  it('rejects null and an invalid Date', () => {
    expect(isPlausibleArticleDate(null, NOW)).toBe(false);
    expect(isPlausibleArticleDate(new Date('nonsense'), NOW)).toBe(false);
  });
});

describe('parseIsoDate', () => {
  it('parses what the model returns', () => {
    expect(parseIsoDate('2025-11-14')).toEqual(new Date('2025-11-14T00:00:00Z'));
  });

  it('returns null for null, empty and unparseable input', () => {
    expect(parseIsoDate(null)).toBeNull();
    expect(parseIsoDate('   ')).toBeNull();
    expect(parseIsoDate('неизвестно')).toBeNull();
  });
});

describe('resolveArticleDate', () => {
  const page = new Date('2023-08-02T09:00:00Z');
  const url = new Date('2023-08-03T00:00:00Z');
  const model = new Date('2023-08-04T00:00:00Z');

  it('prefers page metadata over the URL and the model', () => {
    expect(resolveArticleDate({ fromPage: page, fromUrl: url, fromModel: model }, NOW)).toEqual({
      date: page,
      source: 'page',
    });
  });

  it('falls back to the URL when the page has no date', () => {
    expect(resolveArticleDate({ fromPage: null, fromUrl: url, fromModel: model }, NOW)).toEqual({
      date: url,
      source: 'url',
    });
  });

  it('falls back to the model when neither the page nor the URL has one', () => {
    expect(resolveArticleDate({ fromModel: model }, NOW)).toEqual({ date: model, source: 'model' });
  });

  it('skips an implausible candidate and uses the next source instead of aborting', () => {
    const bogusPageDate = new Date('1970-01-01T00:00:00Z');
    expect(resolveArticleDate({ fromPage: bogusPageDate, fromUrl: url }, NOW)).toEqual({ date: url, source: 'url' });
  });

  it('returns null rather than ever substituting the current date', () => {
    expect(resolveArticleDate({}, NOW)).toEqual({ date: null, source: null });
    expect(resolveArticleDate({ fromPage: null, fromUrl: null, fromModel: null }, NOW)).toEqual({
      date: null,
      source: null,
    });
  });
});
