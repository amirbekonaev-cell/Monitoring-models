import { Injectable, Logger } from '@nestjs/common';
import Parser from 'rss-parser';
import { hashMentionText } from '../../common/hash.util';

export interface ParsedRssItem {
  title: string;
  text: string;
  url: string;
  publishedAt: Date | null;
  hash: string;
}

@Injectable()
export class RssService {
  private readonly logger = new Logger(RssService.name);
  private readonly parser = new Parser({ timeout: 15000 });

  async fetchFeed(feedUrl: string): Promise<ParsedRssItem[]> {
    const feed = await this.parser.parseURL(feedUrl);
    const items: ParsedRssItem[] = [];

    for (const item of feed.items ?? []) {
      const title = (item.title ?? '').trim();
      const url = (item.link ?? '').trim();
      if (!title || !url) {
        continue;
      }
      const text = (item.contentSnippet ?? item.content ?? item.summary ?? '').toString().trim();
      const publishedAt = item.isoDate ? new Date(item.isoDate) : item.pubDate ? new Date(item.pubDate) : null;

      items.push({
        title,
        text,
        url,
        publishedAt,
        hash: hashMentionText(title, text || url),
      });
    }

    return items;
  }
}
