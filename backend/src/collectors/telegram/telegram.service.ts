import { Injectable } from '@nestjs/common';
import * as cheerio from 'cheerio';
import { hashMentionText } from '../../common/hash.util';
import { CollectedItem } from '../../common/collector-run.util';

const FETCH_TIMEOUT_MS = 15000;

/** Accepts t.me/<channel>, https://t.me/<channel>, @channel, or a bare channel name. */
export function extractTelegramChannel(input: string): string | null {
  const trimmed = input.trim();
  const tMeMatch = trimmed.match(/t\.me\/(?:s\/)?([A-Za-z0-9_]{5,32})\/?$/i);
  if (tMeMatch) {
    return tMeMatch[1];
  }
  const handleMatch = trimmed.match(/^@?([A-Za-z0-9_]{5,32})$/);
  if (handleMatch) {
    return handleMatch[1];
  }
  return null;
}

@Injectable()
export class TelegramService {
  /**
   * К-3: reads the public "instant view" preview of a Telegram channel at t.me/s/<channel>.
   * This page is served to anyone without login and without the bot needing to be a channel
   * admin (a hard requirement of the regular Bot API for reading arbitrary public channels),
   * so it's the practical way to follow public channels by just a link.
   */
  async fetchChannel(channelUrl: string): Promise<CollectedItem[]> {
    const channel = extractTelegramChannel(channelUrl);
    if (!channel) {
      throw new Error(`Не удалось определить имя Telegram-канала из ссылки: ${channelUrl}`);
    }

    const previewUrl = `https://t.me/s/${channel}`;
    const html = await this.download(previewUrl);
    const $ = cheerio.load(html);

    if ($('.tgme_channel_info').length === 0 && $('.tgme_widget_message').length === 0) {
      throw new Error(`Канал не найден или приватный: ${channel}`);
    }

    const items: CollectedItem[] = [];
    $('.tgme_widget_message_wrap').each((_, el) => {
      const wrap = $(el);
      const textEl = wrap.find('.tgme_widget_message_text').first();
      const text = textEl.text().trim();
      if (!text) {
        return;
      }

      const link = wrap.find('a.tgme_widget_message_date').attr('href');
      const dateAttr = wrap.find('time.time').attr('datetime');
      if (!link) {
        return;
      }

      const title = text.split('\n')[0].slice(0, 200);
      items.push({
        title,
        text,
        url: link,
        publishedAt: dateAttr ? new Date(dateAttr) : null,
        hash: hashMentionText(title, text),
      });
    });

    return items;
  }

  private async download(url: string): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: controller.signal, headers: { Accept: 'text/html' } });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      return await res.text();
    } finally {
      clearTimeout(timeout);
    }
  }
}
