import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { hashMentionText } from '../../common/hash.util';
import { CollectedItem } from '../../common/collector-run.util';
import { Keyword, KeywordType } from '../../keywords/keyword.entity';

const FETCH_TIMEOUT_MS = 15000;

/**
 * К-4 соцсеть: ВКонтакте.
 *
 * Выбор: официальный VK API, `newsfeed.search` — приложение регистрируется мгновенно на
 * vk.com/apps?act=manage, access_token для чтения открытых постов выдаётся без ручной
 * модерации (в отличие от X/Meta Graph API, где доступ к поиску по ключевым словам требует
 * платной подписки/ревью приложения). Подходит для рынка РФ/КЗ, где у большинства
 * казахстанских компаний есть паблики VK.
 */
@Injectable()
export class VkService {
  private readonly logger = new Logger(VkService.name);

  constructor(private readonly config: ConfigService) {}

  private buildQuery(keywords: Keyword[]): string | null {
    const active = keywords.filter((k) => k.isActive);
    const positive = active.filter((k) => k.type === KeywordType.REQUIRED || k.type === KeywordType.EXACT_PHRASE);
    if (positive.length === 0) {
      return null;
    }
    // VK newsfeed.search takes one plain-text query (no boolean operators) — use the first
    // active positive keyword as the primary search term, which matches how most monitoring
    // tools use a single VK query per "topic" (company name).
    return positive[0].phrase;
  }

  async search(keywords: Keyword[]): Promise<CollectedItem[]> {
    const accessToken = this.config.get<string>('vk.accessToken');
    if (!accessToken) {
      throw new Error('VK_ACCESS_TOKEN не задан — создайте приложение на vk.com/apps?act=manage и добавьте токен в .env');
    }

    const query = this.buildQuery(keywords);
    if (!query) {
      this.logger.warn('Нет активных ключевых слов (required/exact_phrase) — пропускаем цикл K-4');
      return [];
    }

    const apiVersion = this.config.get<string>('vk.apiVersion') ?? '5.199';
    const url = new URL('https://api.vk.com/method/newsfeed.search');
    url.searchParams.set('q', query);
    url.searchParams.set('count', '50');
    url.searchParams.set('access_token', accessToken);
    url.searchParams.set('v', apiVersion);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(url.toString(), { signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }

    if (!res.ok) {
      throw new Error(`VK API HTTP ${res.status}`);
    }

    const payload = (await res.json()) as {
      error?: { error_msg?: string };
      response?: { items?: Array<{ id: number; owner_id: number; text?: string; date?: number }> };
    };

    if (payload.error) {
      throw new Error(`VK API error: ${payload.error.error_msg ?? 'unknown'}`);
    }

    const items: CollectedItem[] = [];
    for (const post of payload.response?.items ?? []) {
      const text = (post.text ?? '').trim();
      if (!text) {
        continue;
      }
      const postUrl = `https://vk.com/wall${post.owner_id}_${post.id}`;
      const title = text.slice(0, 200);
      const publishedAt = post.date ? new Date(post.date * 1000) : null;

      items.push({
        title,
        text,
        url: postUrl,
        publishedAt,
        hash: hashMentionText(title, text),
      });
    }

    return items;
  }
}