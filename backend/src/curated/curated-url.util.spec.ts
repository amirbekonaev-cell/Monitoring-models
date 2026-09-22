import { curatedHost, curatedLinkRef, curatedUrlHash, normalizeCuratedUrl } from './curated-url.util';

describe('normalizeCuratedUrl', () => {
  it('lowercases the host but leaves the path case alone', () => {
    // profit.kz serves mixed-case slugs; lowercasing the path would 404 them.
    expect(normalizeCuratedUrl('https://EXAMPLE.com/Kasim-Esergepov/')).toBe('https://example.com/Kasim-Esergepov');
  });

  it('drops the #fragment', () => {
    expect(normalizeCuratedUrl('https://example.com/a#section-2')).toBe('https://example.com/a');
  });

  it('drops utm_* parameters but keeps the rest of the query', () => {
    expect(normalizeCuratedUrl('https://example.com/?mod=news_read&id=164916&utm_source=tg&utm_medium=x')).toBe(
      'https://example.com/?mod=news_read&id=164916',
    );
  });

  it('keeps the query string that carries the page identity', () => {
    const a = normalizeCuratedUrl('https://example.com/?mod=news_read&id=164916');
    const b = normalizeCuratedUrl('https://example.com/?mod=news_read&id=150840');
    expect(a).not.toBe(b);
  });

  it('strips a trailing slash only when the path is longer than "/"', () => {
    expect(normalizeCuratedUrl('https://example.com/a/b/')).toBe('https://example.com/a/b');
    expect(normalizeCuratedUrl('https://example.com/')).toBe('https://example.com/');
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeCuratedUrl('  https://example.com/a  ')).toBe('https://example.com/a');
  });

  it('throws on something that is not a URL — the caller reports the line, not the content', () => {
    expect(() => normalizeCuratedUrl('not a url')).toThrow();
  });
});

describe('curatedUrlHash', () => {
  it('is a 64-char sha256 hex digest', () => {
    expect(curatedUrlHash('https://example.com/a')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is equal for two spellings that normalize to the same URL', () => {
    expect(curatedUrlHash('https://EXAMPLE.com/a/#x')).toBe(curatedUrlHash('https://example.com/a'));
  });

  it('differs when only the query differs', () => {
    expect(curatedUrlHash('https://example.com/?id=1')).not.toBe(curatedUrlHash('https://example.com/?id=2'));
  });
});

describe('curatedHost', () => {
  it('lowercases and drops www.', () => {
    expect(curatedHost('https://WWW.Example.com/a')).toBe('example.com');
  });

  it('keeps a meaningful subdomain', () => {
    expect(curatedHost('https://ru.example.com/a')).toBe('ru.example.com');
  });
});

describe('curatedLinkRef', () => {
  it('produces a log reference with no URL in it', () => {
    const ref = curatedLinkRef('0123abcd-89ef-4000-8000-000000000000', 'example.com');
    expect(ref).toBe('link 0123abcd @ example.com');
    expect(ref).not.toContain('http');
  });

  it('survives a missing host', () => {
    expect(curatedLinkRef('0123abcd-89ef-4000-8000-000000000000', null)).toContain('unknown-host');
  });
});
