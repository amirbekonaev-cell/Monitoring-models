import { Sentiment } from '../mentions/mention.entity';
import { encodeSearchPeriod, SearchPeriod } from '../curated/search-window.util';
import { LiveFind } from './live-find.types';

/** Префикс ключа в таблице `settings`. Одна строка на период — см. LiveFindStoreService. */
const KEY_PREFIX = 'live_finds:';

/**
 * Ключ строки для периода. `settings.key` — varchar(100): самый длинный случай это свой отрезок,
 * `live_finds:2026-07-01~2026-10-15` — 32 символа.
 */
export function liveFindsSettingKey(period: SearchPeriod): string {
  return `${KEY_PREFIX}${encodeSearchPeriod(period)}`;
}

interface StoredFind {
  title: string;
  url: string;
  publishedAt: string | null;
  sourceName: string;
  domain: string;
  summary: string | null;
  sentiment: string;
}

interface StoredPayload {
  savedAt: string;
  finds: StoredFind[];
}

/**
 * Разобранная запись: находки и момент, когда их сохранил /search.
 *
 * `savedAt` нужен затем, чтобы окно периода при повторном чтении считалось от ТОГО ЖЕ момента,
 * что и у списка заголовков, который человек уже увидел. Считай его от «сейчас» — и статья на
 * границе окна (поиск за неделю вечером, разворот после полуночи) выпала бы из сообщений, хотя в
 * списке она есть.
 */
export interface StoredLiveFinds {
  savedAt: Date | null;
  finds: LiveFind[];
}

export function serializeLiveFinds(finds: readonly LiveFind[], now: Date): string {
  const payload: StoredPayload = {
    savedAt: now.toISOString(),
    finds: finds.map((find) => ({
      title: find.title,
      url: find.url,
      publishedAt: find.publishedAt ? find.publishedAt.toISOString() : null,
      sourceName: find.sourceName,
      domain: find.domain,
      summary: find.summary,
      sentiment: find.sentiment,
    })),
  };
  return JSON.stringify(payload);
}

/**
 * Разбор сохранённой строки. Ничего не бросает: сломанный или чужой JSON — это `null`, а не
 * падение /search. Хранилище лишь дополняет выдачу находками, и его содержимое не вправе решать,
 * ответит бот человеку или нет.
 *
 * `null` (строку разобрать нечем) и пустой список находок (в тот раз живой поиск не нашёл ничего)
 * различаются намеренно: первое стоит предупреждения в логе, второе — обычный результат.
 *
 * Непригодные записи выбрасываются поштучно (нет адреса или заголовка, дата не разбирается),
 * чтобы одна испорченная находка не стоила читателю остальных.
 */
export function parseLiveFinds(raw: string): StoredLiveFinds | null {
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return null;
  }

  const finds = (payload as StoredPayload | null)?.finds;
  if (!Array.isArray(finds)) {
    return null;
  }

  const parsed: LiveFind[] = [];
  for (const entry of finds) {
    const find = parseFind(entry as Partial<StoredFind>);
    if (find) {
      parsed.push(find);
    }
  }

  return { savedAt: parseSavedAt((payload as StoredPayload).savedAt), finds: parsed };
}

/** null, если момента сохранения в записи нет или он не разбирается, — тогда окно периода
 *  отсчитывается от текущего момента (см. LiveFindStoreService). */
function parseSavedAt(raw: unknown): Date | null {
  if (typeof raw !== 'string') {
    return null;
  }
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function parseFind(entry: Partial<StoredFind> | null): LiveFind | null {
  if (!entry || typeof entry.url !== 'string' || !entry.url.trim() || typeof entry.title !== 'string') {
    return null;
  }

  let publishedAt: Date | null = null;
  if (typeof entry.publishedAt === 'string') {
    const parsed = new Date(entry.publishedAt);
    if (Number.isNaN(parsed.getTime())) {
      return null;
    }
    publishedAt = parsed;
  }

  return {
    title: entry.title,
    url: entry.url,
    publishedAt,
    sourceName: typeof entry.sourceName === 'string' ? entry.sourceName : '',
    domain: typeof entry.domain === 'string' ? entry.domain : '',
    summary: typeof entry.summary === 'string' ? entry.summary : null,
    sentiment: toSentiment(entry.sentiment),
  };
}

/** Незнакомая тональность — «не определена», а не отброшенная находка: статья от этого не хуже. */
function toSentiment(value: unknown): Sentiment {
  const known = Object.values(Sentiment) as string[];
  return typeof value === 'string' && known.includes(value) ? (value as Sentiment) : Sentiment.UNDEFINED;
}
