import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Sentiment } from '../mentions/mention.entity';
import { ParserService } from '../collectors/parser/parser.service';

const FETCH_TIMEOUT_MS = 30000;
const RESPONSES_API_URL = 'https://api.openai.com/v1/responses';
const MAX_INPUT_LENGTH = 6000;

// Below this length, mention.text is treated as a preview/announcement (e.g. an RSS feed that
// only publishes a teaser) rather than the actual article body — too short to classify sentiment
// reliably, so classify() goes and fetches the full page instead of trusting it.
const MIN_FULL_TEXT_LENGTH = 400;

const SYSTEM_PROMPT =
  'Ты определяешь тональность упоминания компании в материале (новость, пост, комментарий) — ' +
  'тексте может быть на казахском, русском, английском или любом другом языке, определи её ' +
  'независимо от языка. Тебе передан заголовок и содержание материала — прочитай именно ' +
  'содержание статьи целиком, а не только заголовок: заголовок часто нейтральный или ' +
  'кликбейтный и сам по себе не отражает тональность текста. ' +
  'Ответь строго в формате, заданном схемой ответа: поле "sentiment" — ровно одно из значений ' +
  '"positive", "negative" или "neutral" (по отношению к компании из материала, а не к тексту ' +
  'вообще); поле "reason" — короткое обоснование на русском языке в одну фразу, со ссылкой на ' +
  'то, что именно в тексте статьи привело к такому выводу; поле "summary" — краткий пересказ ' +
  'сути материала на русском языке в 1-2 предложения (не более ~250 символов), нейтральным ' +
  'тоном изложения (о чём материал, а не оценка тональности) — этот текст показывается людям ' +
  'вместо полной статьи, поэтому должен быть самодостаточным и понятным без перехода по ссылке.';

/**
 * Per-call overrides. `undefined`/omitted means every caller gets SYSTEM_PROMPT verbatim — the
 * shared prompt above is used by all ingestion channels, and changing it for one of them would
 * silently change the summaries of the other five.
 */
export interface SentimentClassifyOptions {
  /**
   * Ask for a summary of roughly this many words instead of the default "1-2 sentences, ~250
   * characters". Only the closed pool passes it (CURATED_SUMMARY_WORDS), because only the pool
   * shows the summary *instead of* the article — the reader has no link to follow. The response
   * schema is unchanged either way: still the same three fields, only the length guidance differs.
   */
  summaryWords?: number;
}

/**
 * SYSTEM_PROMPT with the summary-length sentence replaced when (and only when) a caller asked for
 * a word count. With no options, or a non-positive/garbage count, the returned string is
 * byte-for-byte SYSTEM_PROMPT — a test asserts exactly that, because it is the whole guarantee
 * that the other channels' behaviour is untouched.
 */
export function buildSentimentPrompt(options?: SentimentClassifyOptions): string {
  const words = options?.summaryWords;
  if (typeof words !== 'number' || !Number.isFinite(words) || words <= 0) {
    return SYSTEM_PROMPT;
  }
  const rounded = Math.round(words);
  return SYSTEM_PROMPT.replace(
    'в 1-2 предложения (не более ~250 символов)',
    `объёмом около ${rounded} слов`,
  );
}

const RESPONSE_JSON_SCHEMA = {
  type: 'json_schema' as const,
  name: 'sentiment_classification',
  strict: true,
  schema: {
    type: 'object',
    properties: {
      sentiment: { type: 'string', enum: ['positive', 'negative', 'neutral'] },
      reason: { type: 'string' },
      summary: { type: 'string' },
    },
    required: ['sentiment', 'reason', 'summary'],
    additionalProperties: false,
  },
};

const VALID_SENTIMENTS = new Set<string>([Sentiment.POSITIVE, Sentiment.NEGATIVE, Sentiment.NEUTRAL]);

export interface SentimentClassification {
  sentiment: Sentiment;
  reason: string;
  summary: string;
}

interface ResponsesApiOutputItem {
  type: string;
  content?: Array<{ type: string; text?: string }>;
}

interface ResponsesApiPayload {
  output_text?: string;
  output?: ResponsesApiOutputItem[];
  error?: { message?: string };
}

/**
 * Определяет тональность упоминания через обычный (без web_search) запрос к OpenAI Responses
 * API — переиспользует тот же OPENAI_API_KEY, что и К-6 (OpenAiWebSearchService), но отдельную
 * модель (OPENAI_SENTIMENT_MODEL), поскольку это простая классификация текста, а не поиск: не
 * нуждается в дорогой модели с поддержкой web_search.
 *
 * Ответ модели — structured output (`text.format: json_schema`, `strict: true`), а не свободный
 * текст: парсинг детерминированный (JSON.parse + проверка enum), а не regex по произвольной фразе.
 *
 * Различие временных и постоянных ошибок (см. classify()): сетевые сбои/429/5xx — временные,
 * classify() их пробрасывает наружу, распознавая транзиентную ошибку и позволяя вызывающему коду
 * решить, что делать (ретрай/лог); отсутствие ключа/4xx (кроме 429)/неразбираемый ответ —
 * постоянные, classify() логирует один раз и возвращает null, тональность остаётся
 * Sentiment.UNDEFINED без ретраев.
 */
@Injectable()
export class SentimentAnalysisService implements OnModuleInit {
  private readonly logger = new Logger(SentimentAnalysisService.name);

  // Счётчик вызовов классификации тональности за время жизни процесса — логируется на каждый
  // вызов для сверки с панелью OpenAI usage, по аналогии с tool_usage-логированием К-6
  // (OpenAiWebSearchService). Сбрасывается при перезапуске backend — это ожидаемо, точный счёт
  // живёт в биллинге OpenAI.
  private totalCallsSinceStart = 0;

  constructor(
    private readonly config: ConfigService,
    private readonly parserService: ParserService,
  ) {}

  /**
   * Says once, at startup, whether tone can be determined at all. Without this the only signal a
   * missing key gives is a warning inside classify() — which nobody reads until they notice the
   * whole dataset sitting at "не определена" weeks later. A misspelled variable name in .env
   * (OPEN_API_KEY instead of OPENAI_API_KEY — a real one, found on this project) looks exactly
   * like no key at all, and this is where that becomes obvious.
   */
  onModuleInit(): void {
    if (this.config.get<string>('sentimentAnalysis.apiKey')) {
      return;
    }
    this.logger.warn(
      'OPENAI_API_KEY не задан — тональность НЕ будет определяться ни для одного упоминания ' +
        '(останется «не определена»). Проверьте имя переменной в .env: код читает ровно ' +
        'OPENAI_API_KEY.',
    );
  }

  async classify(
    title: string,
    text: string,
    url?: string | null,
    options?: SentimentClassifyOptions,
  ): Promise<SentimentClassification | null> {
    const apiKey = this.config.get<string>('sentimentAnalysis.apiKey');
    if (!apiKey) {
      this.logger.warn('OPENAI_API_KEY не задан — тональность оставлена как "не определена"');
      return null;
    }

    const effectiveText = await this.resolveFullText(text, url);

    const content = [title, effectiveText]
      .filter((part) => part && part.trim())
      .join('\n\n')
      .slice(0, MAX_INPUT_LENGTH);
    if (!content.trim()) {
      return null;
    }

    const model = this.config.get<string>('sentimentAnalysis.model');

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
          instructions: buildSentimentPrompt(options),
          input: content,
          text: { format: RESPONSE_JSON_SCHEMA },
        }),
        signal: controller.signal,
      });
    } catch (error) {
      // Network/timeout failure — transient by nature, distinguished from a permanent error below
      // by throwing rather than returning null.
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Сеть недоступна при обращении к OpenAI Responses API (тональность): ${message}`);
    } finally {
      clearTimeout(timeout);
    }

    this.totalCallsSinceStart += 1;
    this.logger.log(
      `OpenAI sentiment classify: вызовов в этом запросе=1, всего с момента запуска=${this.totalCallsSinceStart} ` +
        '(сверяйте с панелью OpenAI usage)',
    );

    const payload = (await res.json()) as ResponsesApiPayload;

    if (!res.ok) {
      const message = `OpenAI Responses API HTTP ${res.status}: ${payload.error?.message ?? 'unknown error'}`;
      if (res.status === 429 || res.status >= 500) {
        // Rate limit / server-side error — transient, thrown for the same reason as the network
        // failure above.
        throw new Error(message);
      }
      // Permanent error (invalid key, malformed request, etc.) — log once, leave "не определена".
      this.logger.error(`Тональность не определена (постоянная ошибка API): ${message}`);
      return null;
    }

    const rawText = extractOutputText(payload);
    const classification = parseClassification(rawText);
    if (!classification) {
      this.logger.warn(`Не удалось разобрать ответ модели тональности: "${rawText}"`);
    }
    return classification;
  }

  /**
   * If `text` looks like a short preview/announcement rather than the full article (e.g. an RSS
   * feed that only sends a teaser), fetch the actual page and classify on that instead — a
   * headline-only or one-sentence blurb is not enough to judge tone reliably. Falls back to the
   * original `text` whenever there's no url, or the fetch fails, or it doesn't actually yield
   * more text than what we already had.
   */
  private async resolveFullText(text: string, url?: string | null): Promise<string> {
    const trimmed = text?.trim() ?? '';
    if (!url || trimmed.length >= MIN_FULL_TEXT_LENGTH) {
      return text;
    }

    const article = await this.parserService.fetchArticleText(url);
    const fullText = article?.text?.trim();
    if (fullText && fullText.length > trimmed.length) {
      return fullText;
    }
    return text;
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

function parseClassification(rawText: string): SentimentClassification | null {
  const trimmed = rawText.trim();
  if (!trimmed) {
    return null;
  }

  let parsed: { sentiment?: unknown; reason?: unknown; summary?: unknown };
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }

  const sentiment = typeof parsed.sentiment === 'string' ? parsed.sentiment.toLowerCase().trim() : '';
  if (!VALID_SENTIMENTS.has(sentiment)) {
    return null;
  }
  const reason = typeof parsed.reason === 'string' ? parsed.reason.trim() : '';
  const summary = typeof parsed.summary === 'string' ? parsed.summary.trim() : '';
  return { sentiment: sentiment as Sentiment, reason, summary };
}
