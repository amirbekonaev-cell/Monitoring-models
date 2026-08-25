import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { hashMentionText } from '../../common/hash.util';
import { CollectedItem } from '../../common/collector-run.util';
import { Keyword, KeywordType } from '../../keywords/keyword.entity';

const FETCH_TIMEOUT_MS = 30000;
const RESPONSES_API_URL = 'https://api.openai.com/v1/responses';

/** Single consolidated source row for this channel (replaces the old one-row-per-platform setup). */
export const SOCIAL_SEARCH_SOURCE_URL = 'openai-search://web';
export const SOCIAL_SEARCH_SOURCE_LABEL = 'Веб-поиск (OpenAI)';

/**
 * Source URLs used before consolidation (one per platform) — kept only so the scheduler can
 * find and disable those old rows on startup instead of leaving them polling nothing.
 */
export const LEGACY_SOCIAL_SEARCH_SOURCE_URLS = [
  'openai-search://instagram',
  'openai-search://facebook',
  'openai-search://threads',
  'openai-search://telegram',
];

interface ResponsesApiAnnotation {
  type: string;
  url?: string;
  title?: string;
  start_index?: number;
  end_index?: number;
}

interface ResponsesApiOutputItem {
  type: string;
  id?: string;
  content?: Array<{ type: string; text?: string; annotations?: ResponsesApiAnnotation[] }>;
}

interface ResponsesApiPayload {
  output?: ResponsesApiOutputItem[];
  error?: { message?: string };
  // Authoritative billed call count — verified live against the real API: a single request
  // can trigger more than one internal web_search_call output item (e.g. one 'search' +
  // one 'open_page', or two refined 'search' queries), but tool_usage.web_search.num_requests
  // is what OpenAI actually bills. Counting output items instead would overstate usage.
  tool_usage?: { web_search?: { num_requests?: number } };
}

/**
 * К-6: поиск упоминаний по всему открытому интернету через инструмент веб-поиска OpenAI
 * (Responses API, `tools: [{ type: 'web_search' }]`) — один общий запрос без ограничения по
 * конкретной площадке (site:/allowed_domains), а не по одному запросу на Instagram/Facebook/
 * Threads/Telegram как раньше. Наш ключ OpenAI даёt доступ к поиску по всему проиндексированному
 * вебу, а не только по нескольким явно перечисленным сайтам — искусственно сужать область
 * поиска доменами значит пропускать упоминания на форумах, в блогах, на новостных сайтах и
 * любых других площадках, которые мы не перечислили явно. Источник (домен) каждой находки
 * определяется постфактум из фактически вернувшейся ссылки (url citation), а не из заранее
 * заданного списка. Каждый вызов инструмента веб-поиска платный (см. README) — поэтому по
 * расписанию вызывается не чаще раза в 30 минут (см. SocialSearchSchedulerService); разовый
 * вызов по требованию (/search) не подчиняется этому расписанию, но остаётся тем же самым
 * ОДНИМ запросом независимо от периода — стоимость одного /search не растёт с длиной периода.
 */
@Injectable()
export class OpenAiWebSearchService {
  private readonly logger = new Logger(OpenAiWebSearchService.name);

  // Счётчик числа вызовов инструмента веб-поиска за время жизни процесса — логируется на
  // каждый цикл, чтобы можно было сверить с фактическим расходом в панели OpenAI. Сбрасывается
  // при перезапуске backend (это ожидаемо: точный счёт живёт в биллинге OpenAI, здесь — только
  // ориентир для логов).
  private totalWebSearchCallsSinceStart = 0;

  constructor(private readonly config: ConfigService) {}

  private buildQuery(keywords: Keyword[]): string | null {
    const active = keywords.filter((k) => k.isActive);
    const positive = active.filter((k) => k.type === KeywordType.REQUIRED || k.type === KeywordType.EXACT_PHRASE);
    if (positive.length === 0) {
      return null;
    }
    const forms = positive.flatMap((k) => [k.phrase, ...(k.manualForms ?? [])]).filter(Boolean);
    const uniqueForms = [...new Set(forms)];
    const quoted = uniqueForms.map((f) => (f.includes(' ') ? `"${f}"` : f));
    return (
      `Найди в открытом интернете любые упоминания компании (${quoted.join(' OR ')}) — в соцсетях ` +
      '(Instagram, Facebook, Threads, публичные Telegram-каналы), на форумах, в блогах, обзорных ' +
      'сайтах и любых других площадках, без ограничения по конкретному сайту или домену. ' +
      'В ответе для каждой найденной страницы явно процитируй фрагмент текста, где встречается ' +
      'название компании, укажи ссылку на источник (используй url citation) и явно назови ' +
      'домен/платформу, откуда взят результат. Если ничего не найдено, так и напиши.'
    );
  }

  async search(keywords: Keyword[]): Promise<CollectedItem[]> {
    const apiKey = this.config.get<string>('openaiSocialSearch.apiKey');
    if (!apiKey) {
      throw new Error(
        'OPENAI_API_KEY не задан — получите ключ на platform.openai.com и добавьте его в .env (никогда не в код)',
      );
    }

    const query = this.buildQuery(keywords);
    if (!query) {
      this.logger.warn('Нет активных ключевых слов (required/exact_phrase) — пропускаем цикл K-6');
      return [];
    }

    const model = this.config.get<string>('openaiSocialSearch.model') ?? 'gpt-4o-mini';

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(RESPONSES_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          // 'low' effort cuts reasoning-token spend materially (verified live: ~250-320
          // reasoning tokens vs 1300+ at the 'medium' default) without changing whether the
          // tool finds anything — the search itself is what surfaces results, not reasoning depth.
          reasoning: { effort: 'low' },
          // No `filters.allowed_domains` here on purpose (see class comment) — this is now a
          // single unrestricted web search covering the whole indexed web, not one call per
          // platform domain.
          tools: [{ type: 'web_search' }],
          include: ['web_search_call.action.sources'],
          input: query,
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    const payload = (await res.json()) as ResponsesApiPayload;

    if (!res.ok) {
      throw new Error(`OpenAI Responses API HTTP ${res.status}: ${payload.error?.message ?? 'unknown error'}`);
    }

    const output = payload.output ?? [];
    // payload.tool_usage.web_search.num_requests is what OpenAI actually bills for this
    // response; it can differ from the number of web_search_call output items (a single
    // response can report 1 billed request while emitting a 'search' + 'open_page' pair, or
    // 2+ billed requests when the model issues refined follow-up queries) — verified live.
    const webSearchCallCount =
      payload.tool_usage?.web_search?.num_requests ?? output.filter((item) => item.type === 'web_search_call').length;
    this.totalWebSearchCallsSinceStart += webSearchCallCount;
    this.logger.log(
      `OpenAI web search (общий запрос по всему интернету): вызовов инструмента в этом запросе=${webSearchCallCount}, ` +
        `всего с момента запуска=${this.totalWebSearchCallsSinceStart} (сверяйте с панелью OpenAI usage)`,
    );

    return this.extractItems(output);
  }

  private extractItems(output: ResponsesApiOutputItem[]): CollectedItem[] {
    const items: CollectedItem[] = [];
    const seenUrls = new Set<string>();

    for (const outputItem of output) {
      if (outputItem.type !== 'message') {
        continue;
      }
      for (const content of outputItem.content ?? []) {
        if (content.type !== 'output_text' || !content.text) {
          continue;
        }
        const text = content.text;
        for (const annotation of content.annotations ?? []) {
          if (annotation.type !== 'url_citation' || !annotation.url) {
            continue;
          }
          if (seenUrls.has(annotation.url)) {
            continue;
          }
          seenUrls.add(annotation.url);

          const snippet = this.extractSnippet(text, annotation.start_index, annotation.end_index);
          const title = annotation.title?.trim() || snippet.slice(0, 120) || annotation.url;
          const sourceLabel = this.domainOf(annotation.url);

          items.push({
            title,
            text: snippet,
            url: annotation.url,
            publishedAt: null,
            hash: hashMentionText(title, snippet),
            sourceLabel,
          });
        }
      }
    }

    return items;
  }

  /**
   * Verified live against the real API: `annotation.start_index`/`end_index` sometimes span
   * only the inline "([t.me](url))" markdown citation marker itself, not the sentence it
   * supports — the model tends to write one list item per line ("N) «quote». (link)"), so the
   * useful content is the whole enclosing line, not the raw annotation slice. Widen to the
   * line, then strip any markdown link fragments (the citation marker(s)) left inside it.
   */
  private extractSnippet(text: string, startIndex: number | undefined, endIndex: number | undefined): string {
    const start = Math.max(0, startIndex ?? 0);
    const end = Math.min(text.length, endIndex ?? text.length);
    const raw = start < end ? text.slice(start, end) : text;

    const lineStart = text.lastIndexOf('\n', start - 1) + 1;
    const lineEndIdx = text.indexOf('\n', end);
    const lineEnd = lineEndIdx === -1 ? text.length : lineEndIdx;
    const line = text.slice(lineStart, lineEnd);

    const stripMarkdownLinks = (s: string) => s.replace(/\(?\[[^\]]*\]\([^)]*\)\)?/g, '').replace(/\s+/g, ' ').trim();

    const cleanedLine = stripMarkdownLinks(line);
    if (cleanedLine.length >= 20) {
      return cleanedLine;
    }
    const cleanedRaw = stripMarkdownLinks(raw);
    return cleanedRaw.length >= cleanedLine.length ? cleanedRaw : raw.trim();
  }

  /** Источник/платформа находки — домен фактически вернувшейся ссылки (без www.). */
  private domainOf(url: string): string {
    try {
      return new URL(url).hostname.replace(/^www\./, '');
    } catch {
      return url;
    }
  }
}