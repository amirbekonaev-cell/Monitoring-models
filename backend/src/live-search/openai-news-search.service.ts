import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Sentiment } from '../mentions/mention.entity';
import { formatIsoDateDisplay } from '../curated/curated-date.util';
import { SearchWindow } from '../curated/search-window.util';
import { LiveFind } from './live-find.types';

const RESPONSES_API_URL = 'https://api.openai.com/v1/responses';

/** Потолок на один вызов. Замерено три прогона подряд: 16.2 / 20.7 / 18.5 с. */
const DEFAULT_TIMEOUT_MS = 26000;

const SENTIMENT_BY_NAME: Record<string, Sentiment> = {
  positive: Sentiment.POSITIVE,
  neutral: Sentiment.NEUTRAL,
  negative: Sentiment.NEGATIVE,
};

/**
 * Схема структурированного ответа. Благодаря ей ОДИН вызов отдаёт сразу всё, из чего состоит
 * материал в выдаче: дату, издание, заголовок, ссылку, пересказ и тональность. Отдельный вызов на
 * тональность (а это ещё ~7 с на каждую статью) не нужен вовсе.
 */
const RESPONSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['items'],
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'url', 'publication', 'publishedAt', 'summary', 'sentiment'],
        properties: {
          title: { type: 'string' },
          url: { type: 'string' },
          publication: { type: 'string' },
          publishedAt: { type: ['string', 'null'], description: 'ГГГГ-ММ-ДД или null' },
          summary: { type: 'string', description: 'пересказ статьи, 25-35 слов, по-русски' },
          sentiment: { type: 'string', enum: ['positive', 'neutral', 'negative'] },
        },
      },
    },
  },
};

interface SchemaItem {
  title: string;
  url: string;
  publication: string;
  publishedAt: string | null;
  summary: string;
  sentiment: string;
}

/**
 * Поиск публикаций о компании по открытому вебу через инструмент веб-поиска OpenAI (Responses
 * API, `tools: [{ type: 'web_search' }]`) со структурированным ответом.
 *
 * Что здесь важно знать, прежде чем менять промпт. Этот канал однажды уже был признан
 * бесполезным, и вывод был неверным: виноват был промпт, а не инструмент. Общий запрос «найди
 * любые упоминания компании» возвращал сайт самой компании, бизнес-реестры, площадку госзакупок,
 * сайт-оценщик репутации и даже конкурента — ни одной новостной статьи и ни одной даты. Тот же
 * ключ и та же модель с промптом «только журналистские материалы, и вот что исключить» отдают
 * tengrinews, bluescreen, profit.kz, Sputnik, Forbes — то есть реальные статьи, причём с частью
 * изданий, которых в наборе нет вообще. Отсюда правило: ЗАПРЕТЫ в промпте (что исключить) здесь
 * важнее формулировки самого запроса, и ослаблять их не стоит.
 *
 * Стоимость: один платный вызов инструмента на один /search (проверено по
 * `tool_usage.web_search.num_requests` — именно его OpenAI выставляет в счёт). От длины периода
 * стоимость не зависит.
 *
 * Выдача непостоянна: три прогона подряд дали пересекающиеся, но разные наборы статей. Это
 * свойство инструмента, а не ошибка — поэтому канал дополняет ленты и набор, а не заменяет их.
 */
/**
 * Строка требования о периоде для промпта.
 *
 * Пусто для «за N дней» и «Всё время»: инструмент и так отдаёт самое свежее, а сужать его
 * формулировками вроде «за последнюю неделю» вредно — в замерах это выбрасывало годные статьи,
 * у которых на странице не было явной даты. А вот отрезок в прошлом назвать обязательно: иначе
 * на вопрос «что было в июле» приходит октябрь.
 */
function periodRequirement(window?: SearchWindow): string {
  if (!window || window.kind !== 'range') {
    return '';
  }
  return (
    `ВАЖНО: нужны статьи, опубликованные с ${formatIsoDateDisplay(window.dateFrom)} по ` +
    `${formatIsoDateDisplay(window.dateTo)} включительно. Материалы вне этого отрезка не нужны.\n\n`
  );
}

@Injectable()
export class OpenAiNewsSearchService {
  private readonly logger = new Logger(OpenAiNewsSearchService.name);

  constructor(private readonly config: ConfigService) {}

  /** Канал включён, только если есть ключ: без него вызывать нечего. */
  get available(): boolean {
    return this.enabled && Boolean(this.apiKey);
  }

  private get enabled(): boolean {
    return this.config.get<boolean>('liveSearch.openaiEnabled') !== false;
  }

  private get apiKey(): string {
    return this.config.get<string>('openaiSocialSearch.apiKey') || '';
  }

  private get model(): string {
    return this.config.get<string>('openaiSocialSearch.model') || 'gpt-5-mini';
  }

  private get timeoutMs(): number {
    const value = this.config.get<number>('liveSearch.openaiTimeoutMs');
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_TIMEOUT_MS;
  }

  private buildInput(brandForms: readonly string[], window?: SearchWindow): string {
    const brand = brandForms.map((form) => `"${form}"`).join(' OR ');
    return (
      `Найди НОВОСТНЫЕ СТАТЬИ И ПУБЛИКАЦИИ В СМИ о казахстанской компании (${brand}) — ` +
      'облачном провайдере.\n\n' +
      // Свой отрезок попадает в сам запрос, а не только в фильтр после ответа: инструмент
      // по умолчанию тянет самое свежее, и на вопрос «что было в июле» он вернул бы октябрь,
      // который фильтр целиком и выбросил бы. Отсечка по датам всё равно остаётся — модели
      // верить на слово в датах нельзя (см. filterFindsToPeriod).
      periodRequirement(window) +
      'Строгие требования:\n' +
      '1. Только журналистские материалы: новости, интервью, обзоры. Каждая ссылка ведёт на ' +
      'КОНКРЕТНУЮ СТАТЬЮ с заголовком и датой.\n' +
      '2. ИСКЛЮЧИ: сайт самой компании и его поддомены, бизнес-реестры и справочники юрлиц, ' +
      'площадки госзакупок, сайты-оценщики репутации, вакансии, карточки компаний в каталогах, ' +
      'сайты конкурентов, архивные ленты и PDF-подшивки без конкретной статьи.\n' +
      '3. publishedAt — дата публикации статьи в формате ГГГГ-ММ-ДД; если на странице её нет, ' +
      'ставь null, НЕ выдумывай.\n' +
      '4. summary — пересказ статьи на 25-35 слов по-русски, только по тому, что написано в статье.\n' +
      '5. sentiment — тональность упоминания компании: positive, neutral или negative.\n' +
      '6. Верни не больше 8 статей, самые свежие в начале.\n' +
      'Если статей не нашлось — верни пустой список items.'
    );
  }

  /**
   * Один вызов веб-поиска. Возвращает пустой список, если канал недоступен (нет ключа или
   * выключен), и БРОСАЕТ исключение при ошибке API — гасит его вызывающий (LiveSearchService),
   * которому и решать, что делать с частично отработавшим проходом.
   *
   * `deadline` — абсолютный момент времени, дальше которого ждать нельзя: весь /search живёт
   * внутри одного 60-секундного вызова на Vercel. Берётся меньшее из своего потолка и остатка
   * общего бюджета прохода.
   */
  async search(brandForms: readonly string[], deadline?: number, window?: SearchWindow): Promise<LiveFind[]> {
    if (!this.available) {
      return [];
    }

    const budgetMs = deadline ? Math.min(this.timeoutMs, deadline - Date.now()) : this.timeoutMs;
    if (budgetMs <= 0) {
      this.logger.warn('Веб-поиск OpenAI пропущен: бюджет прохода исчерпан до начала запроса');
      return [];
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), budgetMs);
    const startedAt = Date.now();

    let payload: Record<string, unknown>;
    let ok: boolean;
    let status: number;
    try {
      const res = await fetch(RESPONSES_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({
          model: this.model,
          // 'low' экономит токены рассуждения и не влияет на то, найдётся ли что-то: находки даёт
          // сам инструмент поиска, а не глубина рассуждения.
          reasoning: { effort: 'low' },
          tools: [{ type: 'web_search' }],
          text: { format: { type: 'json_schema', name: 'mentions', strict: true, schema: RESPONSE_SCHEMA } },
          input: this.buildInput(brandForms, window),
        }),
        signal: controller.signal,
      });
      ok = res.ok;
      status = res.status;
      payload = (await res.json()) as Record<string, unknown>;
    } finally {
      clearTimeout(timer);
    }

    if (!ok) {
      const message = (payload as { error?: { message?: string } }).error?.message ?? 'unknown error';
      throw new Error(`OpenAI Responses API HTTP ${status}: ${message}`);
    }

    const items = this.parseItems(payload);
    const billed = (payload as { tool_usage?: { web_search?: { num_requests?: number } } }).tool_usage?.web_search
      ?.num_requests;
    this.logger.log(
      `Веб-поиск OpenAI: статей ${items.length}, платных вызовов инструмента ${billed ?? '?'}, ` +
        `${Date.now() - startedAt} мс`,
    );

    return items;
  }

  /**
   * Разбор структурированного ответа. `strict: true` обязывает модель соблюдать схему, но ответ
   * всё равно приходит строкой JSON в текстовом поле, а строка может прийти обрезанной (обрыв
   * соединения, упор в лимит токенов). Поэтому разбор защищён: сломанный JSON — это пустая
   * выдача и предупреждение, а не падение /search.
   */
  private parseItems(payload: Record<string, unknown>): LiveFind[] {
    const output = (payload.output ?? []) as Array<{ type: string; content?: Array<{ type: string; text?: string }> }>;
    let text = '';
    for (const item of output) {
      if (item.type !== 'message') {
        continue;
      }
      for (const content of item.content ?? []) {
        if (content.type === 'output_text' && content.text) {
          text += content.text;
        }
      }
    }

    if (!text.trim()) {
      return [];
    }

    let parsed: { items?: SchemaItem[] };
    try {
      parsed = JSON.parse(text) as { items?: SchemaItem[] };
    } catch (error) {
      this.logger.warn(`Веб-поиск OpenAI вернул не-JSON — находки пропущены: ${String(error).slice(0, 160)}`);
      return [];
    }

    const finds: LiveFind[] = [];
    for (const item of parsed.items ?? []) {
      if (!item?.url || !item?.title) {
        continue;
      }
      const domain = domainOf(item.url);
      if (domain === null) {
        // Выдуманный или битый адрес показывать нельзя: ссылка в сообщении должна открываться.
        continue;
      }
      finds.push({
        title: item.title.trim(),
        url: item.url.trim(),
        publishedAt: parseIsoDate(item.publishedAt),
        sourceName: item.publication?.trim() || domain,
        domain,
        summary: item.summary?.trim() || null,
        sentiment: SENTIMENT_BY_NAME[item.sentiment] ?? Sentiment.UNDEFINED,
      });
    }
    return finds;
  }
}

/** Дата статьи как календарный день. Полдень UTC — чтобы день не «съехал» при показе в Алматы. */
function parseIsoDate(value: string | null): Date | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return null;
  }
  const date = new Date(`${value}T12:00:00Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function domainOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    return parsed.hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}
