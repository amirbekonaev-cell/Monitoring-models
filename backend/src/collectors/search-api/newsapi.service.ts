import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { hashMentionText } from '../../common/hash.util';
import { CollectedItem } from '../../common/collector-run.util';
import { Keyword, KeywordType } from '../../keywords/keyword.entity';

const FETCH_TIMEOUT_MS = 15000;

/**
 * К-1 поисковый/новостной канал.
 *
 * Выбор API: NewsAPI.org (`/v2/everything`) — бесплатный ключ выдаётся сразу без ручной
 * модерации, запрос `q` поддерживает булев синтаксис (`OR`, `NOT`, кавычки для точной фразы),
 * что напрямую ложится на нашу модель ключевых слов (обязательные = OR, минус-слова = NOT,
 * точная фраза = кавычки). Альтернативы (GNews, Bing News Search) требуют либо платной
 * подписки, либо более тяжёлой регистрации в Azure — NewsAPI проще поднять для MVP.
 */
@Injectable()
export class NewsApiService {
  private readonly logger = new Logger(NewsApiService.name);

  constructor(private readonly config: ConfigService) {}

  buildQuery(keywords: Keyword[]): string | null {
    const active = keywords.filter((k) => k.isActive);
    const required = active.filter((k) => k.type === KeywordType.REQUIRED).map((k) => this.quoteIfNeeded(k.phrase));
    const exact = active.filter((k) => k.type === KeywordType.EXACT_PHRASE).map((k) => `"${k.phrase}"`);
    const minus = active.filter((k) => k.type === KeywordType.MINUS).map((k) => `NOT ${this.quoteIfNeeded(k.phrase)}`);

    const positive = [...required, ...exact];
    if (positive.length === 0) {
      return null;
    }

    const positiveClause = positive.length > 1 ? `(${positive.join(' OR ')})` : positive[0];
    return [positiveClause, ...minus].join(' ');
  }

  private quoteIfNeeded(phrase: string): string {
    return phrase.includes(' ') ? `"${phrase}"` : phrase;
  }

  async search(keywords: Keyword[]): Promise<CollectedItem[]> {
    const apiKey = this.config.get<string>('newsApi.apiKey');
    if (!apiKey) {
      throw new Error('NEWSAPI_KEY не задан — получите бесплатный ключ на newsapi.org и добавьте в .env');
    }

    const query = this.buildQuery(keywords);
    if (!query) {
      this.logger.warn('Нет активных ключевых слов (required/exact_phrase) — пропускаем цикл K-1');
      return [];
    }

    const url = new URL('https://newsapi.org/v2/everything');
    url.searchParams.set('q', query);
    url.searchParams.set('language', 'ru');
    url.searchParams.set('sortBy', 'publishedAt');
    url.searchParams.set('pageSize', '50');

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(url.toString(), { signal: controller.signal, headers: { 'X-Api-Key': apiKey } });
    } finally {
      clearTimeout(timeout);
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`NewsAPI HTTP ${res.status}: ${body.slice(0, 300)}`);
    }

    const payload = (await res.json()) as {
      articles?: Array<{
        title?: string;
        description?: string;
        content?: string;
        url?: string;
        publishedAt?: string;
      }>;
    };

    const items: CollectedItem[] = [];
    for (const article of payload.articles ?? []) {
      const title = (article.title ?? '').trim();
      const url2 = (article.url ?? '').trim();
      if (!title || !url2) {
        continue;
      }
      const text = (article.description ?? article.content ?? '').trim();
      const publishedAt = article.publishedAt ? new Date(article.publishedAt) : null;

      items.push({
        title,
        text,
        url: url2,
        publishedAt,
        hash: hashMentionText(title, text || url2),
      });
    }

    return items;
  }
}
