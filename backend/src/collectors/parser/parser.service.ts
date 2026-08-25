import { Injectable, Logger } from '@nestjs/common';
import * as cheerio from 'cheerio';
import { hashMentionText } from '../../common/hash.util';
import { CollectedItem } from '../../common/collector-run.util';

const FETCH_TIMEOUT_MS = 15000;
const USER_AGENT = 'Mozilla/5.0 (compatible; MentionsMonitor/1.0; +https://example.com/bot)';

@Injectable()
export class ParserService {
  private readonly logger = new Logger(ParserService.name);

  /**
   * Universal single-page extractor (К-5): fetches one URL and pulls out title/text/date
   * using common heuristics — og:* meta tags, <article>, and publish-time meta tags. Used
   * both for scheduled re-polling of a page-type source and for the immediate "test
   * collection" preview when an admin adds a source by link.
   */
  async fetchPage(url: string): Promise<CollectedItem[]> {
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

    const item: CollectedItem = {
      title,
      text,
      url,
      publishedAt,
      hash: hashMentionText(title, text || url),
    };

    return [item];
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
