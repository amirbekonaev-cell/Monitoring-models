import { Injectable, Logger } from '@nestjs/common';
import { RssService } from '../../collectors/rss/rss.service';
import { ParserService } from '../../collectors/parser/parser.service';
import { extractTelegramChannel } from '../../collectors/telegram/telegram.service';
import { SourceKind } from '../source.entity';

export interface SourceDetectionResult {
  type: SourceKind;
  resolvedUrl: string;
}

/**
 * Auto-detection algorithm (US-2, ТЗ раздел 4):
 *   1. Telegram-ссылка (t.me/..., @channel) -> канал К-3.
 *   2. Иначе проверяем RSS-ленту: сама ссылка уже валидный фид, либо в её HTML есть
 *      <link rel="alternate"> / фид лежит по стандартному пути (/rss, /feed, ...) -> К-2.
 *   3. Иначе -> универсальный парсер страницы, канал К-5.
 */
@Injectable()
export class SourceDetectService {
  private readonly logger = new Logger(SourceDetectService.name);

  constructor(
    private readonly rssService: RssService,
    private readonly parserService: ParserService,
  ) {}

  async detect(inputUrl: string): Promise<SourceDetectionResult> {
    const trimmed = inputUrl.trim();

    const telegramChannel = extractTelegramChannel(trimmed);
    if (telegramChannel) {
      return { type: SourceKind.TELEGRAM, resolvedUrl: `https://t.me/${telegramChannel}` };
    }

    const normalizedUrl = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

    try {
      const directFeed = await this.rssService.fetchFeed(normalizedUrl);
      if (directFeed.length > 0 || normalizedUrl.match(/\.(xml|rss)(\?|$)/i)) {
        return { type: SourceKind.RSS, resolvedUrl: normalizedUrl };
      }
    } catch (error) {
      this.logger.debug(`Not a direct RSS feed: ${normalizedUrl} — ${String(error)}`);
    }

    try {
      const discoveredFeed = await this.parserService.discoverRssFeed(normalizedUrl);
      if (discoveredFeed) {
        await this.rssService.fetchFeed(discoveredFeed);
        return { type: SourceKind.RSS, resolvedUrl: discoveredFeed };
      }
    } catch (error) {
      this.logger.debug(`RSS discovery failed for ${normalizedUrl} — ${String(error)}`);
    }

    return { type: SourceKind.PARSER, resolvedUrl: normalizedUrl };
  }
}