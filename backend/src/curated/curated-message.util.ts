import { Sentiment } from '../mentions/mention.entity';
import { formatSentiment } from '../sentiment/sentiment-display.util';
import { CuratedLinkStatus } from './curated-link.entity';
import { formatDateInTimezone, formatIsoDateDisplay } from './curated-date.util';
import { CuratedMentionView, CuratedSearchResult, PoolStats } from './curated-search.service';
import { escapeHtml, truncateText } from './text.util';

export const SEARCH_PERIOD_PROMPT_TEXT = 'За какой период показать упоминания из пула ссылок?';
export const EMPTY_POOL_TEXT = 'Пул ссылок пуст или ещё не обработан.';

const TITLE_DISPLAY_LENGTH = 200;
/** Telegram's own hard cap on callback_data. */
const CALLBACK_DATA_MAX_BYTES = 64;

/**
 * Shown the moment a period button is pressed, BEFORE CuratedSearchService.search() runs — that
 * call does real work first (the CURATED_LAZY_PROCESS pass downloads still-unprocessed pool
 * pages, extracts their dates and classifies tone through OpenAI, up to CURATED_LAZY_BUDGET_MS),
 * and without this the chat just sits silent for those seconds and looks broken.
 *
 * Deliberately describes only what actually happens: reading source pages and determining tone
 * of links from the pool. It must not claim to be crawling the web for new links — it isn't, and
 * a status line that overstates what the bot does would be a lie to whoever reads it.
 */
export function buildSearchInProgressText(label: string): string {
  return `Ищу упоминания за ${label}…\nЧитаю страницы источников из пула и определяю тональность — это может занять до полуминуты.`;
}

export function buildPeriodConfirmationText(
  label: string,
  dateFrom: string,
  dateTo: string,
  processedNow = 0,
): string {
  const base = `Период: ${label} (с ${formatIsoDateDisplay(dateFrom)} по ${formatIsoDateDisplay(dateTo)})`;
  if (processedNow <= 0) {
    return base;
  }
  return `${base}\nОбработано источников в этом запросе: ${processedNow} (скачаны страницы, определена тональность).`;
}

export function buildHeader(label: string, result: CuratedSearchResult): string {
  const { total, bySentiment, undatedCount, pool, dateFrom, dateTo } = result;
  const lines = [
    `<b>Упоминания за ${escapeHtml(label)}</b> (с ${formatIsoDateDisplay(dateFrom)} по ${formatIsoDateDisplay(dateTo)})`,
    `Всего: ${total} · 🟢 ${bySentiment[Sentiment.POSITIVE]} · 🔴 ${bySentiment[Sentiment.NEGATIVE]} · ` +
      `🟡 ${bySentiment[Sentiment.NEUTRAL]} · ⚪ ${bySentiment[Sentiment.UNDEFINED]}`,
  ];

  if (undatedCount > 0) {
    lines.push(`Без даты публикации (в выборки по периоду не входят): ${undatedCount}`);
  }

  const pending = pool.byStatus[CuratedLinkStatus.PENDING] ?? 0;
  const failed = pool.byStatus[CuratedLinkStatus.FAILED] ?? 0;
  if (pending > 0 || failed > 0) {
    lines.push(`В очереди на обработку: ${pending} · с ошибкой: ${failed}`);
  }

  return lines.join('\n');
}

/** Empty-result text when the pool has data but nothing falls in the chosen period. */
export function buildEmptyPeriodText(label: string, result: CuratedSearchResult, timezone: string): string {
  const { pool } = result;
  const freshest = pool.lastArticleDate ? formatDateInTimezone(pool.lastArticleDate, timezone) : null;
  const freshestClause = freshest ? `, самая свежая статья — ${freshest}` : '';
  return `За ${label} упоминаний в пуле ссылок не найдено. Обработано ссылок: ${pool.byStatus[CuratedLinkStatus.PROCESSED] ?? 0}${freshestClause}.`;
}

export function buildItemBlock(index: number, item: CuratedMentionView, timezone: string): string {
  const title = truncateText(item.title, TITLE_DISPLAY_LENGTH);
  const published = item.publishedAt ? formatDateInTimezone(item.publishedAt, timezone) : 'дата не определена';
  const body = item.summary ?? item.snippet ?? '';
  return (
    `${index}. ${formatSentiment(item.sentiment)} · ${escapeHtml(title)}\n` +
    `${escapeHtml(item.sourceLabel)} · ${published}\n` +
    `${escapeHtml(body)}`
  );
}

export interface BuiltPage {
  text: string;
  shownCount: number;
}

/**
 * Greedily packs as many item blocks as fit under `charLimit`, always including at least one item
 * even if that one alone overflows the limit — Telegram messages should never come back empty.
 * `header` (only ever non-null on the very first page) is included in the same char budget.
 */
export function buildPage(params: {
  header: string | null;
  items: CuratedMentionView[];
  /** Display number of the first item in `items` — carries the running count across "Показать ещё" pages. */
  startIndex: number;
  timezone: string;
  charLimit: number;
}): BuiltPage {
  const { header, items, startIndex, timezone, charLimit } = params;
  let current = header ?? '';
  let shownCount = 0;

  for (let i = 0; i < items.length; i++) {
    const block = buildItemBlock(startIndex + i, items[i], timezone);
    const candidate = current ? `${current}\n\n${block}` : block;
    if (shownCount > 0 && candidate.length > charLimit) {
      break;
    }
    current = candidate;
    shownCount += 1;
  }

  return { text: current, shownCount };
}

export interface ItemBatch {
  /** One Telegram message per entry, in display order, already formatted and escaped. */
  messages: string[];
  /**
   * Running index of the first finding NOT in this batch — the `offset` the next
   * "Показать ещё" carries. Counted over the whole period window (same meaning as buildPage's
   * pagination offset), and advanced by the number of findings this batch COVERS, not by the
   * number of messages Telegram accepted: a send that fails is a lost finding, logged by the
   * caller, never a reason to renumber the rest or hand out the same offset twice.
   */
  nextOffset: number;
  /** Findings still unshown after this batch — the number printed on the button. */
  remaining: number;
}

/**
 * Splits findings into one message per article (SEARCH_ONE_ARTICLE_PER_MESSAGE=true), capped at
 * `batchSize` per button press. Reuses buildItemBlock, so an item reads exactly the same as it
 * does inside a packed buildPage() page — only the envelope differs.
 *
 * Why a cap at all: Telegram rate-limits a bot to roughly 20 messages/minute into one group, and
 * the handler sending them runs inside a Vercel invocation that is killed at 60s. A batch plus the
 * pause between messages has to fit in that budget with room to spare, so the rest of the period
 * is handed over to the next press instead of being streamed in one go.
 */
export function buildItemMessages(params: {
  items: CuratedMentionView[];
  /** 0-based index of `items[0]` within the whole period window. */
  startOffset: number;
  /** Total findings in the window — what `remaining` is measured against. */
  total: number;
  timezone: string;
  batchSize: number;
}): ItemBatch {
  const { items, startOffset, total, timezone } = params;
  // At least one message per press: a batch size of 0 (a mistyped env value) must not turn the
  // button into a no-op that can never make progress.
  const batchSize = Number.isFinite(params.batchSize) && params.batchSize > 0 ? Math.floor(params.batchSize) : 1;

  const batch = items.slice(0, batchSize);
  const messages = batch.map((item, i) => buildItemBlock(startOffset + i + 1, item, timezone));
  const nextOffset = startOffset + batch.length;

  return { messages, nextOffset, remaining: Math.max(total - nextOffset, 0) };
}

/** null when the resulting callback_data would exceed Telegram's 64-byte limit (never happens for
 *  realistic day/offset ranges — a defensive check, not a normal code path). */
export function buildSearchMoreCallbackData(days: number, offset: number): string | null {
  const data = `search_more:${days}:${offset}`;
  return Buffer.byteLength(data, 'utf8') <= CALLBACK_DATA_MAX_BYTES ? data : null;
}

export function buildSearchPeriodCallbackData(days: number): string {
  return `search_period:${days}`;
}

/**
 * Carrier text for the "Показать ещё" button in one-article-per-message mode when the button
 * could not ride along on the last article message, because that particular send failed. Without
 * a fallback carrier, one failed send would strand the reader in the middle of a period with no
 * way to ask for the rest.
 */
export function buildMoreButtonFallbackText(shown: number, total: number): string {
  return `Показано находок: ${shown} из ${total}.`;
}

export const RESET_CONFIRM_CALLBACK_DATA = 'pool_reset:confirm';
export const RESET_CANCEL_CALLBACK_DATA = 'pool_reset:cancel';
export const RESET_CANCELLED_TEXT = 'Сброс отменён — ничего не изменилось.';
export const RESET_NOTHING_TEXT = 'В пуле нет ссылок — сбрасывать нечего.';

/**
 * Confirmation prompt for /reset. Spells out both irreversible parts explicitly rather than a
 * generic "точно?": the tone already classified for these mentions goes with them (manual UI
 * corrections included — `sentiment_manual` does not survive the row being deleted), and
 * re-processing pays OpenAI again. Whoever presses the button should know that before pressing.
 */
export function buildResetConfirmText(preview: { links: number; mentions: number }): string {
  return [
    '<b>Сбросить пул ссылок?</b>',
    `Ссылок вернётся в очередь на обработку: ${preview.links}`,
    `Упоминаний будет удалено: ${preview.mentions}`,
    '',
    'Это необратимо: вместе с упоминаниями пропадёт уже определённая тональность, включая ручные ' +
      'правки в веб-интерфейсе. Повторная обработка снова потратит вызовы OpenAI.',
    'Сами ссылки не теряются — бот обработает их заново по команде /search.',
  ].join('\n');
}

export function buildResetDoneText(outcome: { links: number; mentionsDeleted: number }): string {
  return [
    `Пул сброшен. Удалено упоминаний: ${outcome.mentionsDeleted}, ссылок в очереди: ${outcome.links}.`,
    'Лента и дашборд сейчас пустые — записи появятся снова по мере того, как /search будет ' +
      'обрабатывать ссылки.',
  ].join('\n');
}

/** /status text — pool statistics only, no URLs, no per-channel breakdown (there are no live
 *  channels left to poll — see CuratedSearchService). */
export function buildStatusText(pool: PoolStats, timezone: string): string {
  const byStatus = pool.byStatus;
  const dateRange =
    pool.firstArticleDate && pool.lastArticleDate
      ? `${formatDateInTimezone(pool.firstArticleDate, timezone)} — ${formatDateInTimezone(pool.lastArticleDate, timezone)}`
      : 'нет данных';
  const lastProcessed = pool.lastProcessedAt
    ? new Intl.DateTimeFormat('ru-RU', {
        timeZone: timezone,
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      }).format(pool.lastProcessedAt)
    : 'ещё не запускалась';

  const statusLine = [
    `обработано ${byStatus[CuratedLinkStatus.PROCESSED] ?? 0}`,
    `не релевантны ${byStatus[CuratedLinkStatus.NOT_RELEVANT] ?? 0}`,
    `с ошибкой ${byStatus[CuratedLinkStatus.FAILED] ?? 0}`,
    `в очереди ${byStatus[CuratedLinkStatus.PENDING] ?? 0}`,
  ];
  const excluded = byStatus[CuratedLinkStatus.EXCLUDED] ?? 0;
  if (excluded > 0) {
    statusLine.push(`исключено ${excluded}`);
  }

  return [
    `Пул ссылок: ${pool.totalLinks} всего`,
    `По статусам: ${statusLine.join(' · ')}`,
    `Упоминаний в пуле: ${pool.mentionsTotal}`,
    `Диапазон дат статей: ${dateRange}`,
    `Без даты: ${pool.undatedMentions}`,
    `Последняя обработка: ${lastProcessed}`,
  ].join('\n');
}
