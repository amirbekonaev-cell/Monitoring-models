import { parseCuratedLinksFile } from './curated-links-file.util';
import { curatedUrlHash, normalizeCuratedUrl } from './curated-url.util';

// Every URL here is example.com — the real pool file is never committed and its links never
// appear in tests, only the SHAPES they have (query-string identity, mixed case, trailing
// whitespace). See README "Приватность".

describe('parseCuratedLinksFile', () => {
  it('treats a non-URL line as the group heading for the URLs that follow', () => {
    const { links } = parseCuratedLinksFile(
      ['Tech', 'https://example.com/a', 'https://example.com/b', 'bluescreen', 'https://example.com/c'].join('\n'),
    );

    expect(links.map((l) => [l.groupLabel, l.url])).toEqual([
      ['Tech', 'https://example.com/a'],
      ['Tech', 'https://example.com/b'],
      ['bluescreen', 'https://example.com/c'],
    ]);
  });

  it('keeps a multi-word heading intact', () => {
    const { links } = parseCuratedLinksFile(['kyzylorda news', 'https://example.com/a'].join('\n'));
    expect(links[0].groupLabel).toBe('kyzylorda news');
  });

  it('gives a URL that appears before any heading a null group rather than dropping it', () => {
    const { links } = parseCuratedLinksFile('https://example.com/orphan');
    expect(links).toHaveLength(1);
    expect(links[0].groupLabel).toBeNull();
  });

  it('ignores blank lines and trims trailing whitespace off URL lines', () => {
    // The real file has trailing spaces on several URL lines; untrimmed they break new URL().
    const { links, stats } = parseCuratedLinksFile(
      ['Tech', '', 'https://example.com/a   ', '   ', '  https://example.com/b\t', ''].join('\n'),
    );

    expect(links.map((l) => l.url)).toEqual(['https://example.com/a', 'https://example.com/b']);
    expect(stats.urlLines).toBe(2);
  });

  it('counts a repeated link once and reports the duplicate instead of failing', () => {
    const { links, stats } = parseCuratedLinksFile(
      ['g', 'https://example.com/a', 'https://example.com/b', 'https://example.com/a'].join('\n'),
    );

    expect(links).toHaveLength(2);
    expect(stats.urlLines).toBe(3);
    expect(stats.uniqueUrls).toBe(2);
    expect(stats.duplicateUrls).toBe(1);
  });

  it('treats links differing only in their query string as distinct (the ekaraganda.kz shape)', () => {
    // These pages are identical apart from `id` — collapsing them would lose four of five links.
    const { links, stats } = parseCuratedLinksFile(
      [
        'ekaraganda',
        'https://example.com/?mod=news_read&id=100001',
        'https://example.com/?mod=news_read&id=100002',
      ].join('\n'),
    );

    expect(stats.uniqueUrls).toBe(2);
    expect(stats.duplicateUrls).toBe(0);
    expect(links[0].url).toContain('id=100001');
    expect(links[1].url).toContain('id=100002');
  });

  it('reports a malformed URL line by line number and keeps parsing the rest', () => {
    const { links, stats, malformedLines } = parseCuratedLinksFile(
      ['g', 'https://example.com/a', 'https://', 'https://example.com/b'].join('\n'),
    );

    expect(links).toHaveLength(2);
    expect(stats.malformedUrls).toBe(1);
    expect(malformedLines).toEqual([3]);
  });

  it('carries the normalized url and its hash, matching the standalone helpers', () => {
    const { links } = parseCuratedLinksFile(['g', 'https://EXAMPLE.com/a/?utm_source=x#frag'].join('\n'));

    expect(links[0].url).toBe(normalizeCuratedUrl('https://EXAMPLE.com/a/?utm_source=x#frag'));
    expect(links[0].urlHash).toBe(curatedUrlHash('https://example.com/a'));
    expect(links[0].host).toBe('example.com');
  });

  it('handles CRLF line endings', () => {
    const { links } = parseCuratedLinksFile('Tech\r\nhttps://example.com/a\r\n');
    expect(links).toHaveLength(1);
    expect(links[0].groupLabel).toBe('Tech');
  });

  it('returns nothing for an empty file rather than throwing', () => {
    const { links, stats } = parseCuratedLinksFile('');
    expect(links).toEqual([]);
    expect(stats.uniqueUrls).toBe(0);
  });
});
