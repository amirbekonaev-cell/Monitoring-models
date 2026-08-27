import { ParserService } from './parser.service';

function xmlResponse(body: string, contentType = 'application/xml') {
  return {
    ok: true,
    status: 200,
    headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? contentType : null) },
    text: async () => body,
  };
}

function htmlResponse(body: string) {
  return {
    ok: true,
    status: 200,
    headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? 'text/html' : null) },
    text: async () => body,
  };
}

function notFound() {
  return { ok: false, status: 404, headers: { get: () => null }, text: async () => '' };
}

function articlePage(title: string) {
  return htmlResponse(`<html><head><title>${title}</title></head><body><article><p>Текст материала.</p></article></body></html>`);
}

describe('ParserService.deepCollect', () => {
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn();
    (global as unknown as { fetch: jest.Mock }).fetch = fetchMock;
  });

  it('prefers the sitemap discovered via robots.txt, pruning sub-sitemaps older than the cutoff by <lastmod>', async () => {
    const cutoff = new Date('2026-08-01T00:00:00Z');
    const routes: Record<string, () => unknown> = {
      'https://news.example/robots.txt': () => xmlResponse('Sitemap: https://news.example/sitemap_index.xml', 'text/plain'),
      'https://news.example/sitemap_index.xml': () =>
        xmlResponse(`<?xml version="1.0"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
          <sitemap><loc>https://news.example/sitemap-new.xml</loc><lastmod>2026-08-20T00:00:00Z</lastmod></sitemap>
          <sitemap><loc>https://news.example/sitemap-old.xml</loc><lastmod>2026-01-01T00:00:00Z</lastmod></sitemap>
        </sitemapindex>`),
      'https://news.example/sitemap-new.xml': () =>
        xmlResponse(`<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
          <url><loc>https://news.example/2026/08/some-article-slug</loc><lastmod>2026-08-21T00:00:00Z</lastmod></url>
        </urlset>`),
      'https://news.example/2026/08/some-article-slug': () => articlePage('Свежая статья'),
    };

    fetchMock.mockImplementation(async (url: string) => {
      const handler = routes[url];
      if (!handler) throw new Error(`unexpected fetch: ${url}`);
      return handler();
    });

    const service = new ParserService();
    const { items, strategy } = await service.deepCollect('https://news.example/', cutoff, { fallbackMaxPages: 5 });

    expect(items).toHaveLength(1);
    expect(items[0].title).toBe('Свежая статья');
    expect(strategy).toBe('sitemap');
    // The old sub-sitemap (lastmod before cutoff) must never be fetched at all.
    expect(fetchMock).not.toHaveBeenCalledWith('https://news.example/sitemap-old.xml', expect.anything());
  });

  it('filters out non-article sitemap entries (e.g. a /stati/ category listing) using the same article-URL heuristic as HTML crawling', async () => {
    const cutoff = new Date('2026-01-01T00:00:00Z');
    const routes: Record<string, () => unknown> = {
      'https://news.example/robots.txt': () => xmlResponse('Sitemap: https://news.example/sitemap.xml', 'text/plain'),
      'https://news.example/sitemap.xml': () =>
        xmlResponse(`<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
          <url><loc>https://news.example/stati/</loc><lastmod>2026-08-20T00:00:00Z</lastmod></url>
          <url><loc>https://news.example/2026/08/a-real-article-here</loc><lastmod>2026-08-20T00:00:00Z</lastmod></url>
        </urlset>`),
      'https://news.example/2026/08/a-real-article-here': () => articlePage('Настоящая статья'),
    };
    fetchMock.mockImplementation(async (url: string) => {
      const handler = routes[url];
      if (!handler) throw new Error(`unexpected fetch: ${url}`);
      return handler();
    });

    const service = new ParserService();
    const { items, strategy } = await service.deepCollect('https://news.example/', cutoff, { fallbackMaxPages: 5 });

    expect(items).toHaveLength(1);
    expect(items[0].title).toBe('Настоящая статья');
    expect(strategy).toBe('sitemap');
  });

  it('falls back to HTML-pagination crawling when no sitemap can be discovered at all', async () => {
    const cutoff = new Date('2026-01-01T00:00:00Z');
    const routes: Record<string, () => unknown> = {
      'https://nositemap.example/robots.txt': () => notFound(),
      'https://nositemap.example/sitemap.xml': () => notFound(),
      'https://nositemap.example/sitemap_index.xml': () => notFound(),
      'https://nositemap.example/wp-sitemap.xml': () => notFound(),
      'https://nositemap.example/': () =>
        htmlResponse('<html><body><div class="news"><a href="/news/some-long-article-slug">Заголовок</a></div></body></html>'),
      'https://nositemap.example/news/some-long-article-slug': () => articlePage('Статья без sitemap'),
    };
    fetchMock.mockImplementation(async (url: string) => {
      const handler = routes[url];
      if (!handler) throw new Error(`unexpected fetch: ${url}`);
      return handler();
    });

    const service = new ParserService();
    const { items, strategy } = await service.deepCollect('https://nositemap.example/', cutoff, { fallbackMaxPages: 3 });

    expect(items).toHaveLength(1);
    expect(items[0].title).toBe('Статья без sitemap');
    expect(strategy).toBe('html-pagination');
  });

  it('returns an empty result without throwing when neither a sitemap nor HTML pagination find any articles (e.g. a JS-rendered listing)', async () => {
    const cutoff = new Date('2026-01-01T00:00:00Z');
    const routes: Record<string, () => unknown> = {
      'https://spa.example/robots.txt': () => notFound(),
      'https://spa.example/sitemap.xml': () => notFound(),
      'https://spa.example/sitemap_index.xml': () => notFound(),
      'https://spa.example/wp-sitemap.xml': () => notFound(),
      // A JS-rendered listing page: no real <a href> links to articles in the server HTML.
      'https://spa.example/': () => htmlResponse('<html><body><div id="app"></div></body></html>'),
    };
    fetchMock.mockImplementation(async (url: string) => {
      const handler = routes[url];
      if (!handler) throw new Error(`unexpected fetch: ${url}`);
      return handler();
    });

    const service = new ParserService();
    const { items, strategy } = await service.deepCollect('https://spa.example/', cutoff, { fallbackMaxPages: 3 });

    expect(items).toEqual([]);
    expect(strategy).toBe('none');
  });

  it('honors an override maxArticles cap on the sitemap path, even when more URLs are available', async () => {
    const cutoff = new Date('2026-01-01T00:00:00Z');
    const routes: Record<string, () => unknown> = {
      'https://news.example/robots.txt': () => xmlResponse('Sitemap: https://news.example/sitemap.xml', 'text/plain'),
      'https://news.example/sitemap.xml': () =>
        xmlResponse(`<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
          <url><loc>https://news.example/2026/08/article-one</loc><lastmod>2026-08-20T00:00:00Z</lastmod></url>
          <url><loc>https://news.example/2026/08/article-two</loc><lastmod>2026-08-20T00:00:00Z</lastmod></url>
          <url><loc>https://news.example/2026/08/article-three</loc><lastmod>2026-08-20T00:00:00Z</lastmod></url>
        </urlset>`),
      'https://news.example/2026/08/article-one': () => articlePage('Статья 1'),
    };
    fetchMock.mockImplementation(async (url: string) => {
      const handler = routes[url];
      if (!handler) throw new Error(`unexpected fetch: ${url}`);
      return handler();
    });

    const service = new ParserService();
    const { items, strategy } = await service.deepCollect('https://news.example/', cutoff, {
      fallbackMaxPages: 5,
      maxArticles: 1,
    });

    expect(items).toHaveLength(1);
    expect(strategy).toBe('sitemap');
  });

  it('stops parsing articles once an already-elapsed deadline is hit, returning what was already collected', async () => {
    const cutoff = new Date('2026-01-01T00:00:00Z');
    const routes: Record<string, () => unknown> = {
      'https://news.example/robots.txt': () => xmlResponse('Sitemap: https://news.example/sitemap.xml', 'text/plain'),
      'https://news.example/sitemap.xml': () =>
        xmlResponse(`<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
          <url><loc>https://news.example/2026/08/article-one</loc><lastmod>2026-08-20T00:00:00Z</lastmod></url>
        </urlset>`),
    };
    fetchMock.mockImplementation(async (url: string) => {
      const handler = routes[url];
      if (!handler) throw new Error(`unexpected fetch: ${url}`);
      return handler();
    });

    const service = new ParserService();
    // Already in the past — deepCollect must stop before parsing any article, and must not fall
    // back to the (also unbudgeted-for) HTML-pagination crawl either.
    const { items, strategy } = await service.deepCollect('https://news.example/', cutoff, {
      fallbackMaxPages: 5,
      deadline: Date.now() - 1,
    });

    expect(items).toEqual([]);
    expect(strategy).toBe('none');
    // The deadline check must stop collectUrlsFromSitemaps before it even downloads the sitemap
    // file, not just before parsing whatever articles it would have found in it.
    expect(fetchMock).not.toHaveBeenCalledWith('https://news.example/sitemap.xml', expect.anything());
    expect(fetchMock).not.toHaveBeenCalledWith('https://news.example/2026/08/article-one', expect.anything());
  });
});
