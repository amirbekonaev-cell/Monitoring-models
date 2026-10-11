import { LiveRssFind, LiveRssOutcome } from './live-rss-search.service';

/** Та же экранировка, что у сообщений набора (см. curated-message.util.ts). */
function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function formatDate(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: timezone,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(date);
}

/** Сколько находок живого прохода попадает в одно сообщение. */
export const LIVE_FINDS_PER_MESSAGE = 10;

/**
 * Отчёт живого прохода по лентам — отдельным сообщением ПОСЛЕ выдачи набора, а не внутри неё.
 *
 * Почему отдельно и почему всегда, даже когда находок нет. Отдельно — потому что набор проверен
 * человеком, а это нет: смешать их в одном списке значит выдать непроверенное за проверенное.
 * Всегда — потому что это и есть отчёт о работе, которая действительно была сделана за время
 * ожидания: «проверено 17 лент, 1760 материалов, нового нет» — проверяемое утверждение, а молчание
 * в том же месте читалось бы как «поиск ничего не делал».
 *
 * Строка про недоступные ленты появляется только когда они есть: умолчать о них нельзя — иначе
 * «нового нет» означало бы разные вещи при 17 опрошенных лентах и при 3.
 */
export function buildLiveRssReportText(outcome: LiveRssOutcome, label: string, timezone: string): string {
  const lines = [`<b>Живой проход по RSS-лентам</b> (не проверено вручную)`];

  lines.push(`Опрошено лент: ${outcome.feedsOk} из ${outcome.feedsTotal}, материалов просмотрено: ${outcome.itemsSeen}.`);

  if (outcome.feedsFailed > 0) {
    lines.push(`Недоступно лент: ${outcome.feedsFailed} — за них в этом проходе не отвечаю.`);
  }

  if (outcome.finds.length === 0) {
    lines.push(`Новых упоминаний за ${escapeHtml(label)} в лентах нет.`);
  } else {
    lines.push(`Новых упоминаний за ${escapeHtml(label)}: ${outcome.finds.length}.`);
  }

  // Про отброшенное говорим только когда оно было: иначе две нулевые строки на каждый /search.
  if (outcome.alreadyKnown > 0) {
    lines.push(`Ещё ${outcome.alreadyKnown} совпадени(й) уже есть в наборе — повторно не показываю.`);
  }
  if (outcome.undated > 0) {
    lines.push(`Без даты публикации (в период поместить нечем): ${outcome.undated}.`);
  }

  return lines.join('\n');
}

/** Одна находка: дата, издание, заголовок и ссылка. Тональность не указывается — её никто не определял. */
export function buildLiveFindBlock(find: LiveRssFind, index: number, timezone: string): string {
  const head = `${index}. ${formatDate(find.publishedAt, timezone)} · ${escapeHtml(find.sourceName)}`;
  const title = escapeHtml(find.title);
  const link = `🔗 ${escapeHtml(find.url)}`;
  return [head, title, link].join('\n');
}

/**
 * Находки, упакованные в сообщения по LIVE_FINDS_PER_MESSAGE штук.
 *
 * Пачками, а не одним сообщением на находку: находок живого прохода единицы (замер на реальных
 * лентах — 0 за сутки), и отдельное сообщение на каждую только съедало бы лимит Telegram
 * (~20 сообщений в минуту в группу), который уже расходует выдача набора.
 */
export function buildLiveFindsMessages(finds: LiveRssFind[], timezone: string): string[] {
  const messages: string[] = [];
  for (let i = 0; i < finds.length; i += LIVE_FINDS_PER_MESSAGE) {
    const chunk = finds.slice(i, i + LIVE_FINDS_PER_MESSAGE);
    messages.push(chunk.map((find, n) => buildLiveFindBlock(find, i + n + 1, timezone)).join('\n\n'));
  }
  return messages;
}
