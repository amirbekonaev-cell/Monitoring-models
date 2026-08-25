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
      const path = (() => {
        try {
          return new URL(resolved).pathname;
        } catch {
          return '';
        }
      })();
      const lastSegment = path.split('/').filter(Boolean).pop() ?? '';
      const looksLikeArticle =
        ARTICLE_PATH_HINT.test(path) || ARTICLE_DATE_HINT.test(path) || lastSegment.length >= 12;
      if (looksLikeArticle) {
        links.add(resolved);
      }
    });
    return Array.from(links);
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