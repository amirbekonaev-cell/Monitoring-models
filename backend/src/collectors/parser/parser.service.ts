import { Injectable, Logger } from '@nestjs/common';
import * as cheerio from 'cheerio';
import { hashMentionText } from '../../common/hash.util';
import { CollectedItem } from '../../common/collector-run.util';

const FETCH_TIMEOUT_MS = 15000;
const USER_AGENT = 'Mozilla/5.0 (compatible; MentionsMonitor/1.0; +https://example.com/bot)';

// Polite crawl delay between article/pagination requests within one crawlSite() call.
const CRAWL_DELAY_MS = parseInt(process.env.PARSER_CRAWL_DELAY_MS || '400', 10);

// Regular (non-backfill) plan cycles: shallow listing depth — the site's news section doesn't
// change drastically in 15-20 minutes, so re-walking it deeply every cycle is wasted work.
const DEFAULT_MAX_PAGES = parseInt(process.env.PARSER_MAX_PAGES || '5', 10);

// One-time historical catch-up (source.lastSuccessAt === null, same is_backfill flag used for
// RSS/Telegram) — walk much deeper once to pull in older material from the archive.
const BACKFILL_MAX_PAGES = parseInt(process.env.PARSER_BACKFILL_MAX_PAGES || '25', 10);

// Cap on how many article links we'll actually fetch per crawlSite() call, regardless of how
// many were discovered across listing pages — keeps one misbehaving site from running forever.
const MAX_ARTICLES_PER_CRAWL = parseInt(process.env.PARSER_MAX_ARTICLES_PER_CRAWL || '60', 10);

// Loose heuristic for "this link looks like an individual article/material", not a nav/menu/
// footer link: has a reasonably long last path segment (slug), or a date, or a known article
// path prefix.
const ARTICLE_PATH_HINT = /\/(news|article|articles|post|posts|story|blog)\//i;
const ARTICLE_DATE_HINT = /\/(19|20)\d{2}[\/-](0?[1-9]|1[0-2])[\/-]/;
// Same shape as ARTICLE_DATE_HINT but with capture groups, for actually reading a best-effort
// publish date out of a sitemap URL that carries no <lastmod> (see extractDateFromUrl).
const URL_DATE_PATTERN = /\/((?:19|20)\d{2})[\/-](0?[1-9]|1[0-2])(?:[\/-](0?[1-9]|[12]\d|3[01]))?[\/-]/;

// Cap on how many sitemap files (index + leaf) we'll download for one deepCollect() call —
// keeps a site with a huge, flat sitemap (e.g. hundreds of leaf files) from running forever.
const MAX_SITEMAP_FILES = parseInt(process.env.PARSER_MAX_SITEMAP_FILES || '20', 10);

// Cap on how many article URLs we'll collect from sitemaps before parsing them — separate from
// MAX_ARTICLES_PER_CRAWL so a `deepCollect()` sitemap walk and a `crawlSite()` HTML walk can be
// tuned independently, but same order of magnitude by default.
const MAX_SITEMAP_ARTICLE_URLS = parseInt(process.env.PARSER_MAX_SITEMAP_ARTICLE_URLS || '60', 10);

@Injectable()
export class ParserService {
  private readonly logger = new Logger(ParserService.name);

  getDefaultMaxPages(): number {
    return DEFAULT_MAX_PAGES;
  }

  getBackfillMaxPages(): number {
    return BACKFILL_MAX_PAGES;
  }

  /**
   * Universal single-page extractor (К-5): fetches one URL and pulls out title/text/date
   * using common heuristics — og:* meta tags, <article>, and publish-time meta tags. Used
   * only when an admin adds a source by link (SourceOnboardingService) — the admin points at
   * one specific page and sees right away what could be extracted from it, without a full
   * site crawl. crawlSite() below is the multi-page equivalent.
   */
  async fetchPage(url: string): Promise<CollectedItem[]> {
    const item = await this.parseArticlePage(url);
    return [item];
  }

  /**
   * Fetches just the text of one article page — used by SentimentAnalysisService to resolve the
   * full article body when a channel (e.g. an RSS feed) only surfaced a short teaser.
   */
  async fetchArticleText(url: string): Promise<{ text: string } | null> {
    try {
      const item = await this.parseArticlePage(url);
      return { text: item.text };
    } catch (error) {
      this.logger.debug(`fetchArticleText: не удалось разобрать ${url}: ${String(error)}`);
      return null;
    }
  }

  private async parseArticlePage(url: string): Promise<CollectedItem> {
    const html = await this.download(url);
    const $ = cheerio.load(html);

    const title =
      $('meta[property="og:title"]').attr('content')?.trim() ||
      $('title').first().text().trim() ||
      $('h1').first().text().trim();

    if (!title) {
      throw new Error('Не удалось определить заголовок страницы');
    }

    const text = this.extractBodyText($);
    const publishedAt = this.extractPublishedAt($);

    return {
      title,
      text,
      url,
      publishedAt,
      hash: hashMentionText(title, text || url),
    };
  }

  /**
   * Real site crawl (К-5): downloads the starting listing page, finds links that look like
   * individual articles (<a> inside <article>/card-like containers, or a path matching
   * ARTICLE_PATH_HINT/ARTICLE_DATE_HINT — filters out most nav/menu/footer links), follows
   * pagination (rel="next", "следующая"/"далее" link text, ?page=N, /page/N/) up to `maxPages`
   * listing pages, then parses every discovered article link via parseArticlePage(). One
   * unreachable article or listing page is logged and skipped — the whole crawl doesn't fail
   * (same error isolation as runCollectionCycle). A polite delay (CRAWL_DELAY_MS) is kept between
   * requests.
   */
  async crawlSite(baseUrl: string, options: { maxPages: number }): Promise<CollectedItem[]> {
    const maxPages = Math.max(1, options.maxPages || DEFAULT_MAX_PAGES);
    const seenListingUrls = new Set<string>();
    const articleUrls = new Set<string>();

    let currentUrl: string | null = baseUrl;
    let pagesVisited = 0;

    while (currentUrl && pagesVisited < maxPages && !seenListingUrls.has(currentUrl)) {
      seenListingUrls.add(currentUrl);
      pagesVisited += 1;

      let $: cheerio.CheerioAPI;
      try {
        const html = await this.download(currentUrl);
        $ = cheerio.load(html);
      } catch (error) {
        this.logger.warn(`crawlSite: не удалось открыть страницу листинга ${currentUrl}: ${String(error)}`);
        break;
      }

      for (const link of this.extractArticleLinks($, currentUrl)) {
        articleUrls.add(link);
        if (articleUrls.size >= MAX_ARTICLES_PER_CRAWL) {
          break;
        }
      }

      currentUrl = this.findNextPageUrl($, currentUrl);
      if (currentUrl) {
        await this.delay(CRAWL_DELAY_MS);
      }
    }

    const items: CollectedItem[] = [];
    for (const url of Array.from(articleUrls).slice(0, MAX_ARTICLES_PER_CRAWL)) {
      try {
        items.push(await this.parseArticlePage(url));
      } catch (error) {
        this.logger.warn(`crawlSite: не удалось разобрать материал ${url}: ${String(error)}`);
      }
      await this.delay(CRAWL_DELAY_MS);
    }

    return items;
  }

  private extractArticleLinks($: cheerio.CheerioAPI, baseUrl: string): string[] {
    const links = new Set<string>();
    $('article a[href], .card a[href], .news a[href], a[href]').each((_, el) => {
      const href = $(el).attr('href');
      if (!href) return;
      let resolved: string;
      try {
        resolved = new URL(href, baseUrl).toString();
      } catch {
        return;
      }
      if (this.looksLikeArticleUrl(resolved)) {
        links.add(resolved);
      }
    });
    return Array.from(links);
  }

  /**
   * Loose heuristic for "this URL looks like an individual article/material", shared between
   * HTML-listing crawling (extractArticleLinks) and sitemap walking (collectUrlsFromSitemaps) —
   * both need to skip category/tag/listing pages (e.g. sitemap entries like `/stati/`) that a
   * sitemap or a listing page's <a> tags mix in alongside real articles.
   */
  private looksLikeArticleUrl(url: string): boolean {
    const path = (() => {
      try {
        return new URL(url).pathname;
      } catch {
        return '';
      }
    })();
    const lastSegment = path.split('/').filter(Boolean).pop() ?? '';
    return ARTICLE_PATH_HINT.test(path) || ARTICLE_DATE_HINT.test(path) || lastSegment.length >= 12;
  }

  /** Best-effort publish date read straight out of a URL's path (e.g. `/2026/08/some-slug`) — used
   * when a sitemap <url> entry has no <lastmod>, same idea as ARTICLE_DATE_HINT above. */
  private extractDateFromUrl(url: string): Date | null {
    const match = url.match(URL_DATE_PATTERN);
    if (!match) return null;
    const [, year, month, day] = match;
    const date = new Date(Date.UTC(Number(year), Number(month) - 1, day ? Number(day) : 1));
    return Number.isNaN(date.getTime()) ? null : date;
  }

  /** Looks for a sitemap: `Sitemap:` lines in robots.txt first (authoritative when present), then
   * a couple of well-known paths as a fallback for sites whose robots.txt doesn't list one. */
  private async discoverSitemaps(pageUrl: string): Promise<string[]> {
    try {
      const robotsUrl = new URL('/robots.txt', pageUrl).toString();
      const text = await this.download(robotsUrl);
      const found = [...text.matchAll(/^sitemap:\s*(\S+)/gim)].map((m) => m[1].trim());
      if (found.length > 0) {
        return found;
      }
    } catch (error) {
      this.logger.debug(`discoverSitemaps: не удалось прочитать robots.txt для ${pageUrl}: ${String(error)}`);
    }

    const wellKnownPaths = ['/sitemap.xml', '/sitemap_index.xml', '/wp-sitemap.xml'];
    for (const path of wellKnownPaths) {
      try {
        const candidate = new URL(path, pageUrl).toString();
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);
        const res = await fetch(candidate, { method: 'GET', signal: controller.signal, headers: { 'User-Agent': USER_AGENT } });
        clearTimeout(timeout);
        if (res.ok && (res.headers.get('content-type') || '').includes('xml')) {
          return [candidate];
        }
      } catch {
        // ignore, try next path
      }
    }

    return [];
  }

  /**
   * Walks a sitemap (or sitemap index) starting from `rootUrls`, returning article URLs — pruned
   * to `cutoff` best-effort. A sitemap index's sub-sitemaps are visited newest-`<lastmod>`-first
   * and the walk stops as soon as one is older than `cutoff` (everything behind it in a properly
   * generated index is at least as old) — this is what keeps e.g. matritca.kz's 2022-dated
   * sub-sitemaps from ever being fetched on a routine deep pass. When an index carries no
   * `<lastmod>` at all (e.g. 365info.kz — flat, undated sub-sitemap files, oldest posts first),
   * there is no reliable way to tell which sub-sitemap is newest, so only the last few (as listed)
   * are checked rather than all of them — best-effort, bounded, not exhaustive.
   */
  private async collectUrlsFromSitemaps(rootUrls: string[], cutoff: Date): Promise<string[]> {
    const urls: string[] = [];
    const queue: string[] = [...rootUrls];
    let sitemapsVisited = 0;

    while (queue.length > 0 && urls.length < MAX_SITEMAP_ARTICLE_URLS && sitemapsVisited < MAX_SITEMAP_FILES) {
      const sitemapUrl = queue.shift() as string;
      sitemapsVisited += 1;

      let $: cheerio.CheerioAPI;
      try {
        const xml = await this.download(sitemapUrl);
        $ = cheerio.load(xml, { xmlMode: true });
      } catch (error) {
        this.logger.debug(`collectUrlsFromSitemaps: не удалось загрузить ${sitemapUrl}: ${String(error)}`);
        continue;
      }

      const subSitemaps = $('sitemapindex > sitemap')
        .toArray()
        .map((el) => ({ loc: $(el).find('loc').first().text().trim(), lastmod: $(el).find('lastmod').first().text().trim() }))
        .filter((s) => s.loc);

      if (subSitemaps.length > 0) {
        const dated = subSitemaps.filter((s) => s.lastmod && !Number.isNaN(new Date(s.lastmod).getTime()));
        if (dated.length > 0) {
          dated.sort((a, b) => new Date(b.lastmod).getTime() - new Date(a.lastmod).getTime());
          for (const s of dated) {
            if (new Date(s.lastmod) < cutoff) break;
            queue.push(s.loc);
          }
        } else {
          queue.push(...subSitemaps.slice(-3).map((s) => s.loc));
        }
        continue;
      }

      const urlEntries = $('urlset > url')
        .toArray()
        .map((el) => ({ loc: $(el).find('loc').first().text().trim(), lastmod: $(el).find('lastmod').first().text().trim() }))
        .filter((u) => u.loc && this.looksLikeArticleUrl(u.loc));

      for (const u of urlEntries) {
        const lastmodDate = u.lastmod ? new Date(u.lastmod) : null;
        const effectiveDate = lastmodDate && !Number.isNaN(lastmodDate.getTime()) ? lastmodDate : this.extractDateFromUrl(u.loc);
        if (effectiveDate && effectiveDate < cutoff) continue;
        urls.push(u.loc);
        if (urls.length >= MAX_SITEMAP_ARTICLE_URLS) break;
      }
    }

    return urls;
  }

  /**
   * The "deep" К-5 pass added on top of RSS (see fetchRssWithDeepScan) or run standalone for a
   * К-5 source: prefers the site's sitemap (cheap to prune by `<lastmod>`, usually the complete
   * article archive) and only falls back to walking the HTML listing/pagination
   * (`crawlSite`) when no sitemap could be found or it yielded no article URLs at all. Never
   * throws — a site with neither a usable sitemap nor parseable pagination (e.g. a JS-rendered
   * `/news` page with no server-side links, seen on infozakon.kz) is a legitimate outcome, not a
   * failure: it's logged clearly and an empty result is returned so the source stays healthy
   * (ФТ-2 — this must never take down the fast RSS/parser fetch it's layered on top of).
   */
  async deepCollect(baseUrl: string, cutoff: Date, options: { fallbackMaxPages: number }): Promise<CollectedItem[]> {
    let articleUrls: string[] = [];
    try {
      const sitemapRoots = await this.discoverSitemaps(baseUrl);
      if (sitemapRoots.length > 0) {
        articleUrls = await this.collectUrlsFromSitemaps(sitemapRoots, cutoff);
      }
    } catch (error) {
      this.logger.warn(`deepCollect: обход sitemap не удался для ${baseUrl}: ${String(error)}`);
    }

    if (articleUrls.length > 0) {
      this.logger.log(
        `deepCollect(${baseUrl}): использован sitemap — ${articleUrls.length} ссылок на статьи новее ${cutoff.toISOString().slice(0, 10)}`,
      );
      const items: CollectedItem[] = [];
      for (const url of articleUrls) {
        try {
          items.push(await this.parseArticlePage(url));
        } catch (error) {
          this.logger.warn(`deepCollect: не удалось разобрать материал ${url}: ${String(error)}`);
        }
        await this.delay(CRAWL_DELAY_MS);
      }
      return items;
    }

    try {
      const crawled = await this.crawlSite(baseUrl, { maxPages: options.fallbackMaxPages });
      if (crawled.length > 0) {
        this.logger.log(`deepCollect(${baseUrl}): sitemap не найден/пуст — использована HTML-пагинация, найдено ${crawled.length}`);
        return crawled;
      }
    } catch (error) {
      this.logger.warn(`deepCollect: резервная HTML-пагинация тоже не удалась для ${baseUrl}: ${String(error)}`);
      return [];
    }

    this.logger.warn(
      `deepCollect(${baseUrl}): sitemap не найден и HTML-пагинация не дала ссылок на статьи (возможно, раздел новостей рендерится через JS) — глубокий обход недоступен для этого источника, работает только быстрый канал (RSS/одна страница)`,
    );
    return [];
  }

  private findNextPageUrl($: cheerio.CheerioAPI, currentUrl: string): string | null {
    const relNext = $('a[rel="next"]').first().attr('href');
    if (relNext) {
      try {
        return new URL(relNext, currentUrl).toString();
      } catch {
        return null;
      }
    }

    const textNext = $('a')
      .filter((_, el) => /следующая|далее|next/i.test($(el).text().trim()))
      .first()
      .attr('href');
    if (textNext) {
      try {
        return new URL(textNext, currentUrl).toString();
      } catch {
        return null;
      }
    }

    return null;
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private extractBodyText($: cheerio.CheerioAPI): string {
    const ogDescription = $('meta[property="og:description"]').attr('content')?.trim();
    if (ogDescription) {
      return ogDescription;
    }

    const article = $('article').first();
    if (article.length > 0) {
      return article
        .find('p')
        .map((_, el) => $(el).text().trim())
        .get()
        .filter(Boolean)
        .join(' ')
        .slice(0, 2000);
    }

    return $('p')
      .slice(0, 5)
      .map((_, el) => $(el).text().trim())
      .get()
      .filter(Boolean)
      .join(' ')
      .slice(0, 2000);
  }

  private extractPublishedAt($: cheerio.CheerioAPI): Date | null {
    const candidates = [
      $('meta[property="article:published_time"]').attr('content'),
      $('meta[name="publish-date"]').attr('content'),
      $('meta[name="date"]').attr('content'),
      $('time[datetime]').first().attr('datetime'),
    ];

    for (const candidate of candidates) {
      if (!candidate) continue;
      const date = new Date(candidate);
      if (!Number.isNaN(date.getTime())) {
        return date;
      }
    }
    return null;
  }

  private async download(url: string): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' },
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      return await res.text();
    } finally {
      clearTimeout(timeout);
    }
  }

  /** Looks for an RSS/Atom feed: standard well-known paths, then <link rel="alternate"> in the HTML. */
  async discoverRssFeed(pageUrl: string): Promise<string | null> {
    try {
      const parsed = new URL(pageUrl);
      const html = await this.download(pageUrl);
      const $ = cheerio.load(html);
      const alternate = $('link[rel="alternate"][type*="rss"], link[rel="alternate"][type*="atom"]')
        .first()
        .attr('href');
      if (alternate) {
        return new URL(alternate, parsed).toString();
      }
    } catch (error) {
      this.logger.debug(`RSS discovery via HTML failed for ${pageUrl}: ${String(error)}`);
    }

    const wellKnownPaths = ['/rss', '/rss.xml', '/feed', '/feed.xml', '/atom.xml'];
    for (const path of wellKnownPaths) {
      try {
        const candidate = new URL(path, pageUrl).toString();
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);
        const res = await fetch(candidate, { method: 'GET', signal: controller.signal });
        clearTimeout(timeout);
        if (res.ok) {
          const contentType = res.headers.get('content-type') || '';
          if (contentType.includes('xml') || contentType.includes('rss')) {
            return candidate;
          }
        }
      } catch {
        // ignore, try next path
      }
    }

    return null;
  }
}