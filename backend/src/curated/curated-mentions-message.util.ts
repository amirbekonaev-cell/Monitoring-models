import { CuratedMention, CuratedStats } from './curated-mentions';

/**
 * Тексты и callback_data для команд /curated_stats и /curated <издание>.
 *
 * Вынесено из TelegramBotService по тому же принципу, что и curated-message.util.ts: формат
 * сообщения — чистая функция от данных, её можно проверить тестом, не поднимая бота.
 */

/**
 * Сколько карточек уходит за одно нажатие. Telegram ограничивает бота примерно 20 сообщениями
 * в минуту в одну группу, а у sknews.kz 49 карточек — отправить их разом значит получить 429 на
 * всю пачку. Восемь сообщений с паузой 700 мс укладываются в ~5 секунд и в 60-секундный потолок
 * вызова, по аналогии с SEARCH_ITEMS_PER_BATCH у /search.
 */
export const CURATED_MENTIONS_BATCH_SIZE = 8;

const CALLBACK_PREFIX = 'curated_more';

/** Лимит Telegram на callback_data — 64 байта. */
const CALLBACK_DATA_MAX_BYTES = 64;

export function buildCuratedMoreCallbackData(domain: string, offset: number): string | null {
  if (!Number.isInteger(offset) || offset < 0) {
    return null;
  }
  const data = `${CALLBACK_PREFIX}:${domain}:${offset}`;
  return Buffer.byteLength(data, 'utf8') <= CALLBACK_DATA_MAX_BYTES ? data : null;
}

export function parseCuratedMoreCallbackData(data: string): { domain: string; offset: number } | null {
  // Домен разбирается как «всё между первым и последним двоеточием», а не split(':')[1] —
  // иначе домен с двоеточием молча потерял бы хвост.
  const match = /^curated_more:(.+):(\d+)$/.exec(data);
  if (!match) {
    return null;
  }
  const offset = Number(match[2]);
  return Number.isSafeInteger(offset) && offset >= 0 ? { domain: match[1], offset } : null;
}

/** Сводка по набору: сколько карточек всего, разбивка по тональности и по изданиям. */
export function buildCuratedStatsText(stats: CuratedStats, domainsByName: Map<string, string>): string {
  const lines = [
    '<b>Проверенные карточки упоминаний</b>',
    '',
    `Всего: <b>${stats.total}</b>`,
    `🟩 Позитив: ${stats.positive}`,
    `🟨 Нейтрал: ${stats.neutral}`,
    `🟥 Негатив: ${stats.negative}`,
  ];

  if (stats.undefined > 0) {
    lines.push(`⬜ Не определена: ${stats.undefined}`);
  }

  const sources = Object.entries(stats.bySource).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (sources.length > 0) {
    lines.push('', `<b>Издания (${sources.length})</b>`);
    for (const [name, count] of sources) {
      const domain = domainsByName.get(name);
      lines.push(domain ? `${escapeHtml(name)} — ${count} (<code>${escapeHtml(domain)}</code>)` : `${escapeHtml(name)} — ${count}`);
    }
    lines.push('', 'Карточки одного издания: <code>/curated &lt;домен&gt;</code>');
  }

  return lines.join('\n');
}

/** Подсказка, когда /curated вызвали без аргумента или с неизвестным изданием. */
export function buildCuratedSourceUsageText(domain: string | null, knownDomains: string[]): string {
  const head = domain
    ? `Издание <code>${escapeHtml(domain)}</code> в наборе не найдено.`
    : 'Укажите издание: <code>/curated sknews.kz</code>';
  return [
    head,
    '',
    'Весь набор целиком: <code>/curated all</code>',
    '',
    `<b>Доступные издания (${knownDomains.length})</b>`,
    knownDomains.map((d) => `<code>${escapeHtml(d)}</code>`).join('\n'),
  ].join('\n');
}

/** Заголовок пачки: либо одно издание, либо весь набор (`all`, новые сверху). */
export function buildCuratedSourceHeader(mentions: CuratedMention[], domain: string, offset: number): string {
  const shown = Math.min(offset + CURATED_MENTIONS_BATCH_SIZE, mentions.length);
  const title = domain === 'all' ? 'Все проверенные карточки (новые сверху)' : escapeHtml(domain);
  return (
    `<b>${title}</b> — карточек: ${mentions.length}` +
    (mentions.length > CURATED_MENTIONS_BATCH_SIZE ? ` (показаны ${offset + 1}–${shown})` : '')
  );
}

function escapeHtml(input: string): string {
  return input.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
