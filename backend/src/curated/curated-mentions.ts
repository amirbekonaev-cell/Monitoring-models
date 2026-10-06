import { Sentiment } from '../mentions/mention.entity';
// Файл данных называется *.data.json, а не curated-mentions.json, намеренно: при совпадении
// базовых имён ('curated-mentions.ts' и 'curated-mentions.json' в одной папке) tsc разрешает
// импорт '../curated/curated-mentions' в .ts, а Node/ts-node — в .json. Код компилировался, но
// в рантайме и seed:curated, и send:curated получали голый массив вместо модуля и падали на
// первом же вызове (getCuratedSortedByDate is not a function).
import rawData from './curated-mentions.data.json';

/**
 * Готовые (вручную проверенные) карточки упоминаний QazCloud.
 *
 * Это ЕДИНСТВЕННЫЙ источник правды для этих 168 материалов: заголовок, дата, краткое
 * содержание и тональность уже написаны человеком. Бот ничего не досочиняет и не вызывает
 * LLM — он просто берёт готовый текст и отправляет его как отдельное сообщение.
 *
 * Чтобы поправить любую карточку — правьте curated-mentions.json, не код.
 */

/** Тональность в том виде, как она записана в JSON. */
export type CuratedSentiment = 'positive' | 'neutral' | 'negative' | 'undefined';

/** Насколько надёжно проверена публикация (взято из пометок в исходном документе). */
export type CuratedStatus = 'verified' | 'partial' | 'unverified' | 'duplicate';

export interface CuratedMention {
  /** Номер пункта из исходного документа, например "17.13". Стабильный ключ карточки. */
  id: string;
  /** Короткое имя издания: "SK News", "Profit.kz", ... */
  sourceName: string;
  /** Домен публикации: "sknews.kz", "profit.kz", ... */
  sourceDomain: string;
  title: string;
  url: string;
  /** ISO-дата публикации (YYYY-MM-DD) либо null, если дату установить не удалось. */
  publishedAt: string | null;
  /** Дата в том виде, как она стоит на сайте — для случаев вроде "25 сәуір 2023". */
  publishedAtText: string;
  /** Готовое краткое содержание (~50 слов). Отправляется как есть. */
  summary: string;
  sentiment: CuratedSentiment;
  /** Обоснование тональности в скобках из исходного документа. Может быть пустым. */
  sentimentNote: string;
  status: CuratedStatus;
  /** Для дубликата — id пункта-оригинала. */
  duplicateOf?: string;
}

export const CURATED_MENTIONS: CuratedMention[] = rawData as CuratedMention[];

/** Маппинг в enum Sentiment из mention.entity — чтобы карточки ложились в ту же БД/UI. */
export const CURATED_SENTIMENT_TO_ENUM: Record<CuratedSentiment, Sentiment> = {
  positive: Sentiment.POSITIVE,
  neutral: Sentiment.NEUTRAL,
  negative: Sentiment.NEGATIVE,
  undefined: Sentiment.UNDEFINED,
};

/** Подписи ровно как в telegram-notifier.service.ts, чтобы сообщения выглядели одинаково. */
const SENTIMENT_LABEL: Record<CuratedSentiment, string> = {
  positive: '🟩 Позитив',
  negative: '🟥 Негатив',
  neutral: '🟨 Нейтрал',
  undefined: '⬜ Не определена',
};

const SENTIMENT_SCALE: Record<CuratedSentiment, string> = {
  negative: '🔴⚪⚪',
  neutral: '⚪🟡⚪',
  positive: '⚪⚪🟢',
  undefined: '⚪⚪⚪',
};

const STATUS_LABEL: Record<CuratedStatus, string> = {
  verified: '',
  partial: 'частично проверено',
  unverified: 'источник не открывался — данные по URL',
  duplicate: 'дубликат',
};

/**
 * Метки переходов: не идентифицируют материал и мешают совпадению, когда ссылка пришла из
 * рассылки или соцсети. Всё остальное в query-строке сохраняется — см. normalizeUrl.
 */
const TRACKING_PARAM = /^(utm_[a-z0-9_]*|gclid|yclid|fbclid|ysclid|_openstat)$/;

/**
 * Нормализация URL для поиска: схема, www, завершающий слеш, якорь и utm-хвосты не должны
 * мешать совпадению.
 *
 * Query-строка при этом НЕ срезается целиком. На ekaraganda.kz именно она идентифицирует
 * материал ('?mod=news_read&id=164916'), и срезание всей строки склеивало пять разных статей
 * (пункты 11.1–11.5) в один ключ 'ekaraganda.kz': четыре из них становились недостижимы через
 * findCuratedByUrl, а seed увидел бы их как один и тот же материал. Функция идемпотентна —
 * normalizeUrl(normalizeUrl(x)) === normalizeUrl(x).
 */
export function normalizeUrl(url: string): string {
  const withoutScheme = url
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/#.*$/, '');

  const queryStart = withoutScheme.indexOf('?');
  const path = (queryStart === -1 ? withoutScheme : withoutScheme.slice(0, queryStart)).replace(/\/+$/, '');
  if (queryStart === -1) {
    return path;
  }

  const params = withoutScheme
    .slice(queryStart + 1)
    .split('&')
    .filter((part) => part && !TRACKING_PARAM.test(part.split('=')[0]));

  return params.length > 0 ? `${path}?${params.join('&')}` : path;
}

const BY_URL = new Map<string, CuratedMention>();
const BY_ID = new Map<string, CuratedMention>();
for (const item of CURATED_MENTIONS) {
  BY_ID.set(item.id, item);

  // Один и тот же URL у двух пунктов (3.14 — сознательный дубликат 3.10): по ссылке должен
  // находиться оригинал, а не дубликат. Проверяем status явно, а не полагаемся на порядок
  // записей в JSON — иначе перестановка двух строк в файле молча меняла бы то, какой текст
  // уходит в Telegram.
  const key = normalizeUrl(item.url);
  const kept = BY_URL.get(key);
  if (!kept || (kept.status === 'duplicate' && item.status !== 'duplicate')) {
    BY_URL.set(key, item);
  }
}

/** Готовая карточка для этого URL, если она есть. Главная точка входа для бота. */
export function findCuratedByUrl(url: string): CuratedMention | undefined {
  return BY_URL.get(normalizeUrl(url));
}

export function findCuratedById(id: string): CuratedMention | undefined {
  return BY_ID.get(id);
}

export function hasCurated(url: string): boolean {
  return BY_URL.has(normalizeUrl(url));
}

export function getCuratedBySource(domain: string): CuratedMention[] {
  const needle = domain.toLowerCase().replace(/^www\./, '');
  return CURATED_MENTIONS.filter((m) => m.sourceDomain === needle);
}

export function getCuratedBySentiment(sentiment: CuratedSentiment): CuratedMention[] {
  return CURATED_MENTIONS.filter((m) => m.sentiment === sentiment);
}

/** Отсортированный по дате список (новые сверху); материалы без даты уходят в конец. */
export function getCuratedSortedByDate(): CuratedMention[] {
  return [...CURATED_MENTIONS].sort((a, b) => {
    if (!a.publishedAt) return 1;
    if (!b.publishedAt) return -1;
    return b.publishedAt.localeCompare(a.publishedAt);
  });
}

export interface CuratedStats {
  total: number;
  positive: number;
  neutral: number;
  negative: number;
  undefined: number;
  bySource: Record<string, number>;
}

export function getCuratedStats(): CuratedStats {
  const stats: CuratedStats = {
    total: CURATED_MENTIONS.length,
    positive: 0,
    neutral: 0,
    negative: 0,
    undefined: 0,
    bySource: {},
  };
  for (const m of CURATED_MENTIONS) {
    stats[m.sentiment] += 1;
    stats.bySource[m.sourceName] = (stats.bySource[m.sourceName] ?? 0) + 1;
  }
  return stats;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(value: string): string {
  return escapeHtml(value).replace(/"/g, '&quot;');
}

/**
 * Готовое сообщение для Telegram (parse_mode: 'HTML') — одна карточка = одно сообщение.
 * Никакой генерации текста: берутся только поля из JSON.
 */
export function formatCuratedMessage(m: CuratedMention): string {
  const href = escapeAttr(m.url);
  const date = m.publishedAtText?.trim() || m.publishedAt || 'дата не определена';

  const lines = [
    `${SENTIMENT_SCALE[m.sentiment]} ${SENTIMENT_LABEL[m.sentiment]} | ` +
      `<a href="${href}">${escapeHtml(m.sourceDomain)}</a> | ${escapeHtml(date)}`,
    `<b><a href="${href}">${escapeHtml(m.title)}</a></b>`,
    '',
    escapeHtml(m.summary),
  ];

  if (m.sentimentNote) {
    lines.push('', `<i>Тональность: ${escapeHtml(m.sentimentNote)}</i>`);
  }

  const status = STATUS_LABEL[m.status];
  if (status) {
    const suffix = m.duplicateOf ? `${status} пункта ${m.duplicateOf}` : status;
    lines.push(`<i>⚠️ ${escapeHtml(suffix)}</i>`);
  }

  lines.push('', `🔗 ${escapeHtml(m.url)}`);
  return lines.join('\n');
}

/** Простой plain-text вариант — для логов, CSV, выгрузок и тестов. */
export function formatCuratedPlain(m: CuratedMention): string {
  return [
    `[${m.id}] ${m.sourceName}`,
    m.title,
    m.url,
    `Дата: ${m.publishedAtText || m.publishedAt || 'не определена'}`,
    `Содержание: ${m.summary}`,
    `Тональность: ${m.sentiment}${m.sentimentNote ? ` (${m.sentimentNote})` : ''}`,
  ].join('\n');
}
