import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { curatedHost } from './curated-url.util';

const RESPONSES_API_URL = 'https://api.openai.com/v1/responses';
const FETCH_TIMEOUT_MS = 60000;

/**
 * Structured result of reading ONE pool page through the model. `mentionsCompany` is the model's
 * own opinion — in `openai` read mode it is combined with (never substituted for) the keyword
 * match that every other channel uses, so a model hallucinating a mention cannot by itself
 * create one.
 */
export interface OpenAiPageRead {
  title: string | null;
  /** ISO date as the page itself states it, or null when the page shows none. */
  publishedAtIso: string | null;
  mentionsCompany: boolean;
  /** Passages around the company mention, verbatim from the page. */
  fragments: string[];
  /** Billed tool calls for this request — `tool_usage.web_search.num_requests`. */
  webSearchCalls: number;
}

const RESPONSE_JSON_SCHEMA = {
  type: 'json_schema' as const,
  name: 'curated_page_read',
  strict: true,
  schema: {
    type: 'object',
    properties: {
      title: { type: ['string', 'null'] },
      published_at: {
        type: ['string', 'null'],
        description: 'Дата публикации материала в формате YYYY-MM-DD, если она указана на странице; иначе null.',
      },
      mentions_company: { type: 'boolean' },
      fragments: {
        type: 'array',
        items: { type: 'string' },
        description: 'Дословные фрагменты страницы вокруг упоминания компании.',
      },
    },
    required: ['title', 'published_at', 'mentions_company', 'fragments'],
    additionalProperties: false,
  },
};

interface ResponsesApiOutputItem {
  type: string;
  content?: Array<{ type: string; text?: string }>;
}

interface ResponsesApiPayload {
  output_text?: string;
  output?: ResponsesApiOutputItem[];
  error?: { message?: string };
  tool_usage?: { web_search?: { num_requests?: number } };
}

/**
 * Fallback reader for pool pages the plain HTTP parser cannot get at — anti-bot walls and
 * JS-rendered articles both come back as an empty or teaser-length body from ParserService
 * (see CuratedIngestService's `auto` mode). The model's `web_search` tool can open such a page.
 *
 * Shaped after OpenAiWebSearchService (same Responses API, same request/error handling, same
 * `tool_usage.web_search.num_requests` accounting) with two deliberate differences:
 *
 *  - `filters.allowed_domains` is pinned to the ONE host of the link being read, and the prompt
 *    says to open exactly that URL and search for nothing else. This is the opposite of К-6,
 *    which deliberately searches the whole web: here the page to read is already known, and a
 *    model that wandered off to a different article would attach some other page's text, date
 *    and tone to this link.
 *  - it runs regardless of `SOCIAL_SEARCH_ENABLED`. That flag switches off К-6 as a *collection
 *    channel*; the closed pool is a different feature that merely borrows the same API and key,
 *    the way SentimentAnalysisService already does.
 *
 * Every call is billed, so CuratedIngestService only reaches this after the free path has
 * actually failed, and never for a link already marked processed.
 */
@Injectable()
export class CuratedOpenAiReaderService {
  private readonly logger = new Logger(CuratedOpenAiReaderService.name);

  private totalWebSearchCallsSinceStart = 0;

  constructor(private readonly config: ConfigService) {}

  getTotalWebSearchCalls(): number {
    return this.totalWebSearchCallsSinceStart;
  }

  isConfigured(): boolean {
    return Boolean(this.config.get<string>('openaiSocialSearch.apiKey'));
  }

  /**
   * Reads one page. `companyForms` are the spellings to look for (the active keyword phrases and
   * their manual forms), passed in rather than loaded here so this service stays a pure API
   * client with no DB dependency.
   *
   * Throws on a missing key or an API error — the caller turns that into `attempts + 1` and a
   * human-readable `last_error`, never a crash of the whole run.
   */
  async readPage(url: string, companyForms: string[], signal?: AbortSignal): Promise<OpenAiPageRead> {
    const apiKey = this.config.get<string>('openaiSocialSearch.apiKey');
    if (!apiKey) {
      throw new Error('OPENAI_API_KEY не задан — страницу нельзя прочитать через OpenAI (см. .env.example)');
    }

    const host = curatedHost(url);
    const model = this.config.get<string>('openaiSocialSearch.model') ?? 'gpt-5-mini';
    const forms = [...new Set(companyForms.map((f) => f.trim()).filter(Boolean))];

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const abortFromExternal = () => controller.abort();
    if (signal) {
      if (signal.aborted) {
        controller.abort();
      } else {
        signal.addEventListener('abort', abortFromExternal, { once: true });
      }
    }

    let res: Response;
    try {
      res = await fetch(RESPONSES_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          // Same 'low' effort as К-6: reading one known page is an extraction task, not a
          // reasoning one — deeper reasoning costs tokens without improving the extraction.
          reasoning: { effort: 'low' },
          tools: [
            {
              type: 'web_search',
              // Hard domain pin. The prompt alone is not enough of a guarantee that the model
              // stays on this page; this makes any other host unreachable for the tool.
              filters: { allowed_domains: [host] },
            },
          ],
          // The page must actually be opened — an answer written from the model's own memory of
          // the site would be fabricated content attributed to a real article.
          tool_choice: { type: 'web_search' },
          instructions: this.buildInstructions(forms),
          input: this.buildInput(url, forms),
          text: { format: RESPONSE_JSON_SCHEMA },
        }),
        signal: controller.signal,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`OpenAI недоступен при чтении страницы (${host}): ${message}`);
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abortFromExternal);
    }

    const payload = (await res.json()) as ResponsesApiPayload;

    if (!res.ok) {
      throw new Error(`OpenAI Responses API HTTP ${res.status} (${host}): ${payload.error?.message ?? 'unknown error'}`);
    }

    const webSearchCalls = payload.tool_usage?.web_search?.num_requests ?? 0;
    this.totalWebSearchCallsSinceStart += webSearchCalls;
    // Host only, never the URL — see curated-url.util.ts's curatedLinkRef().
    this.logger.log(
      `OpenAI чтение страницы (${host}): вызовов web_search=${webSearchCalls}, ` +
        `всего с момента запуска=${this.totalWebSearchCallsSinceStart} (сверяйте с панелью OpenAI usage)`,
    );

    return { ...this.parseRead(extractOutputText(payload)), webSearchCalls };
  }

  private buildInstructions(forms: string[]): string {
    return (
      'Ты читаешь ровно одну веб-страницу по указанной ссылке и извлекаешь из неё факты. ' +
      'Открой именно эту страницу через инструмент веб-поиска и не ищи ничего за её пределами: ' +
      'не используй другие статьи, другие сайты и собственные воспоминания о них. ' +
      `Компания, упоминания которой нужно искать, пишется так: ${forms.join(', ')} (регистр не важен). ` +
      'Ответь строго по схеме: "title" — заголовок материала (null, если страница не открылась); ' +
      '"published_at" — дата публикации в формате YYYY-MM-DD, ровно так, как она указана на самой ' +
      'странице; если даты на странице нет — null, НИКОГДА не подставляй сегодняшнюю дату и не ' +
      'угадывай её; "mentions_company" — true только если название компании действительно есть в ' +
      'тексте страницы; "fragments" — дословные фрагменты текста страницы вокруг каждого упоминания ' +
      'компании (по 1-3 предложения), пустой массив, если упоминаний нет.'
    );
  }

  private buildInput(url: string, forms: string[]): string {
    return (
      `Открой страницу ${url} и извлеки из неё данные по схеме. ` +
      `Искомые написания названия компании: ${forms.join(', ')}.`
    );
  }

  private parseRead(rawText: string): Omit<OpenAiPageRead, 'webSearchCalls'> {
    const empty = { title: null, publishedAtIso: null, mentionsCompany: false, fragments: [] };
    const trimmed = rawText.trim();
    if (!trimmed) {
      return empty;
    }

    let parsed: { title?: unknown; published_at?: unknown; mentions_company?: unknown; fragments?: unknown };
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      this.logger.warn('Ответ модели при чтении страницы не разобран как JSON — страница считается непрочитанной');
      return empty;
    }

    return {
      title: typeof parsed.title === 'string' && parsed.title.trim() ? parsed.title.trim() : null,
      publishedAtIso:
        typeof parsed.published_at === 'string' && parsed.published_at.trim() ? parsed.published_at.trim() : null,
      mentionsCompany: parsed.mentions_company === true,
      fragments: Array.isArray(parsed.fragments)
        ? parsed.fragments.filter((f): f is string => typeof f === 'string' && f.trim().length > 0).map((f) => f.trim())
        : [],
    };
  }
}

function extractOutputText(payload: ResponsesApiPayload): string {
  if (typeof payload.output_text === 'string' && payload.output_text.trim()) {
    return payload.output_text;
  }
  for (const item of payload.output ?? []) {
    if (item.type !== 'message') {
      continue;
    }
    for (const content of item.content ?? []) {
      if (typeof content.text === 'string' && content.text.trim()) {
        return content.text;
      }
    }
  }
  return '';
}
