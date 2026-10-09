import { Sentiment } from '../mentions/mention.entity';
import { formatSentiment } from '../sentiment/sentiment-display.util';
import { CuratedLinkStatus } from './curated-link.entity';
import { formatDateInTimezone, formatIsoDateDisplay } from './curated-date.util';
import { CardSetStats, CuratedMentionView, CuratedSearchResult, PoolStats } from './curated-search.types';
import { escapeHtml, truncateText } from './text.util';

export const SEARCH_PERIOD_PROMPT_TEXT = 'За какой период показать упоминания из пула ссылок?';
export const EMPTY_POOL_TEXT = 'Пул ссылок пуст или ещё не обработан.';

const TITLE_DISPLAY_LENGTH = 200;
/** Telegram's own hard cap on callback_data. */
const CALLBACK_DATA_MAX_BYTES = 64;

/**
 * Shown the moment a period button is pressed, before the results message replaces it.
 *
 * Deliberately one short line with no promise about duration: the search is now a filter over the
 * in-memory card set (CuratedJsonSearchService), so there is nothing to wait for. It used to warn
 * about "up to half a minute" because the old DB path downloaded pages and called OpenAI first —
 * saying that now would be a lie, and a status line must never overstate what the bot does.
 */
export function buildSearchInProgressText(label: string): string {
  return `Ищу упоминания за ${label}…`;
}

/**
 * The resolved window, nothing else. There is deliberately no "Обработано источников в этом
 * запросе" line any more: the bot processes no sources at all now — /search reads ready-made cards
 * (see CuratedJsonSearchService), so the count was always 0 and the line only ever described work
 * the old OpenAI path did.
 */
export function buildPeriodConfirmationText(label: string, dateFrom: string, dateTo: string): string {
  return `Период: ${label} (с ${formatIsoDateDisplay(dateFrom)} по ${formatIsoDateDisplay(dateTo)})`;
}

/**
 * First lines of the results message: window, totals, sentiment split.
 *
 * No queue line ("В очереди на обработку") any more — the cards come from a JSON file that is
 * never processed, so there is no queue to report and the line could only ever print zeros.
 */
export function buildHeader(label: string, result: CuratedSearchResult): string {
  const { total, bySentiment, undatedCount, dateFrom, dateTo } = result;
  const lines = [
    `<b>Упоминания за ${escapeHtml(label)}</b> (с ${formatIsoDateDisplay(dateFrom)} по ${formatIsoDateDisplay(dateTo)})`,
    `Всего: ${total} · 🟢 ${bySentiment[Sentiment.POSITIVE]} · 🔴 ${bySentiment[Sentiment.NEGATIVE]} · ` +
      `🟡 ${bySentiment[Sentiment.NEUTRAL]} · ⚪ ${bySentiment[Sentiment.UNDEFINED]}`,
  ];

  if (undatedCount > 0) {
    lines.push(`Без даты публикации (в выборки по периоду не входят): ${undatedCount}`);
  }

  return lines.join('\n');
}

/**
 * Empty-result text when there is data but nothing falls in the chosen period. Two wordings,
 * because the two sources have genuinely different things to say about why: a set of ready-made
 * cards has a size and a freshest date, a DB pool has a count of links it managed to process.
 */
export function buildEmptyPeriodText(label: string, result: CuratedSearchResult, timezone: string): string {
  const { pool } = result;
  const freshest = pool.lastArticleDate ? formatDateInTimezone(pool.lastArticleDate, timezone) : null;
  const freshestClause = freshest ? `, самая свежая статья — ${freshest}` : '';
  if (pool.cards) {
    return `За ${label} упоминаний не найдено. Материалов в наборе: ${pool.cards.shown}${freshestClause}.`;
  }
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

/**
 * Одна строка списка заголовков: номер, тональность, дата, издание, заголовок. Без пересказа и
 * без ссылки — список должен давать обзор «что нашлось и сколько», а подробности уходят в
 * отдельное сообщение по каждой статье.
 */
export function buildTitleLine(index: number, item: CuratedMentionView, timezone: string): string {
  const title = truncateText(item.title, TITLE_DISPLAY_LENGTH);
  const published = item.publishedAt ? formatDateInTimezone(item.publishedAt, timezone) : 'дата не определена';
  return `${index}. ${formatSentiment(item.sentiment)} ${published} · ${escapeHtml(item.sourceLabel)}\n${escapeHtml(title)}`;
}

/**
 * Полный список заголовков найденного, разбитый на сообщения по `charLimit`.
 *
 * Именно список, а не упакованная страница с пересказами (buildPage): сначала читатель видит
 * ЦЕЛИКОМ, что нашлось за период и сколько этого, и только потом решает, разворачивать ли статьи
 * по одной. Поэтому здесь нет ни «Показать ещё», ни обрезки по количеству — все найденные
 * заголовки обязаны уйти, сколько бы сообщений на это ни потребовалось.
 *
 * `header` попадает в первое сообщение и считается в тот же бюджет символов. В каждом сообщении
 * оказывается хотя бы одна строка, даже если она одна уже длиннее лимита — пустых сообщений
 * Telegram не принимает.
 */
export function buildTitleListMessages(params: {
  header: string | null;
  items: CuratedMentionView[];
  /** Номер, под которым показывается `items[0]`. */
  startIndex: number;
  timezone: string;
  charLimit: number;
}): string[] {
  const { header, items, startIndex, timezone, charLimit } = params;
  const messages: string[] = [];
  let current = header ?? '';

  for (let i = 0; i < items.length; i++) {
    const line = buildTitleLine(startIndex + i, items[i], timezone);
    const candidate = current ? `${current}\n\n${line}` : line;
    if (current && candidate.length > charLimit) {
      messages.push(current);
      current = line;
      continue;
    }
    current = candidate;
  }

  if (current) {
    messages.push(current);
  }
  return messages;
}

/** Вопрос перед разворачиванием: выводить ли каждую статью отдельным сообщением. */
export function buildExpandPromptText(total: number): string {
  return (
    `Вывести каждую статью отдельным сообщением? Всего найдено: ${total}.\n` +
    'В каждом сообщении будут пересказ и ссылка на материал.'
  );
}

export const SEARCH_EXPAND_YES_TEXT = 'Да, по одной';
export const SEARCH_EXPAND_NO_TEXT = 'Нет, хватит списка';
export const SEARCH_EXPAND_DECLINED_TEXT = 'Хорошо — оставляю только список заголовков.';

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
  const messages = batch.map((item, i) => withLink(buildItemBlock(startOffset + i + 1, item, timezone), item));
  const nextOffset = startOffset + batch.length;

  return { messages, nextOffset, remaining: Math.max(total - nextOffset, 0) };
}

/**
 * Дописывает ссылку на материал — только в сообщении про ОДНУ статью.
 *
 * Ссылка живёт здесь, а не в buildItemBlock, хотя блок у них общий: buildItemBlock используется
 * ещё и упакованной страницей (buildPage) и списком заголовков, а те обязаны оставаться без
 * ссылок — на них же смотрит проба «Telegram formatter» в curated:leak-check. Так ссылки попадают
 * ровно в тот вывод, который пользователь запросил кнопкой «Да, по одной».
 *
 * `item.url === null` у источника закрытого пула (CuratedSearchService) — тогда строки просто
 * нет, и поведение для пула не меняется ни на символ.
 */
function withLink(block: string, item: CuratedMentionView): string {
  if (!item.url) {
    return block;
  }
  // Голый адрес отдельной строкой, а не <a href>: его видно целиком, можно скопировать, и он
  // читается одинаково в превью уведомления и в самом сообщении.
  return `${block}\n🔗 ${escapeHtml(item.url)}`;
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
 * Кнопка «Да, по одной» и продолжение этого же потока («Показать ещё» под последней статьёй).
 * Отдельный префикс от `search_more`, потому что режимы разные: `search_each` всегда шлёт по
 * одному сообщению на статью со ссылкой, независимо от SEARCH_ONE_ARTICLE_PER_MESSAGE.
 *
 * null — если callback_data не влезает в 64 байта Telegram (для реальных дней/смещений не
 * случается, защитная проверка).
 */
export function buildSearchExpandCallbackData(days: number, offset: number): string | null {
  const data = `search_each:${days}:${offset}`;
  return Buffer.byteLength(data, 'utf8') <= CALLBACK_DATA_MAX_BYTES ? data : null;
}

/** Кнопка «Нет» под вопросом о разворачивании. Без периода — отвечать нечем, нужно только убрать клавиатуру. */
export const SEARCH_EXPAND_DECLINE_CALLBACK_DATA = 'search_each:no';

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
      'правки в веб-интерфейсе.',
    'На /search и /status это НЕ влияет — они читают готовые карточки из curated-mentions.data.json, ' +
      'а не эту таблицу. Затронуты только лента и дашборд.',
  ].join('\n');
}

export function buildResetDoneText(outcome: { links: number; mentionsDeleted: number }): string {
  return [
    `Пул сброшен. Удалено упоминаний: ${outcome.mentionsDeleted}, ссылок в очереди: ${outcome.links}.`,
    'Лента и дашборд по этим ссылкам сейчас пустые — наполнить их заново можно скриптом ' +
      'npm run seed:curated. На /search и /status сброс не повлиял.',
  ].join('\n');
}

/**
 * /status for the ready-made card set (the bot's source — see CuratedJsonSearchService). Describes
 * what the set contains, not how far some queue has got: these cards are written by hand and never
 * processed, so "в очереди", "с ошибкой" and "последняя обработка" have no meaning here and
 * printing them as zeros would only invite the question of what is stuck.
 */
function buildCardSetStatusText(cards: CardSetStats, pool: PoolStats, timezone: string): string {
  const dateRange =
    pool.firstArticleDate && pool.lastArticleDate
      ? `${formatDateInTimezone(pool.firstArticleDate, timezone)} — ${formatDateInTimezone(pool.lastArticleDate, timezone)}`
      : 'нет данных';

  const lines = [
    `Готовых карточек: ${cards.total} всего, доступно для /search: ${cards.shown}`,
    `Тональность: 🟢 ${cards.bySentiment[Sentiment.POSITIVE]} · 🔴 ${cards.bySentiment[Sentiment.NEGATIVE]} · ` +
      `🟡 ${cards.bySentiment[Sentiment.NEUTRAL]} · ⚪ ${cards.bySentiment[Sentiment.UNDEFINED]}`,
    `Проверено: ${cards.byStatus.verified} · частично: ${cards.byStatus.partial} · по URL: ${cards.byStatus.unverified}`,
    `Диапазон дат статей: ${dateRange}`,
    `Без даты: ${pool.undatedMentions}`,
  ];

  if (cards.duplicates > 0) {
    lines.push(`Скрыто как дубликаты: ${cards.duplicates}`);
  }

  return lines.join('\n');
}

/**
 * /status text — statistics only, no URLs, no per-channel breakdown (there are no live channels
 * left to poll). Renders the card-set variant when the stats came from the JSON source, and the
 * link-pool variant when they came from the DB one (the CLI scripts).
 */
export function buildStatusText(pool: PoolStats, timezone: string): string {
  if (pool.cards) {
    return buildCardSetStatusText(pool.cards, pool, timezone);
  }

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
