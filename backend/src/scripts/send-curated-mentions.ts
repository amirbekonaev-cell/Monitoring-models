import 'dotenv/config';
import { Telegraf } from 'telegraf';
import {
  CURATED_MENTIONS,
  CuratedMention,
  formatCuratedMessage,
  getCuratedSortedByDate,
} from '../curated/curated-mentions';

/**
 * Отправляет готовые карточки в Telegram — по одному сообщению на каждое упоминание.
 * Текст не генерируется: берётся ровно то, что лежит в curated-mentions.json.
 *
 * Запуск:
 *   npm run send:curated -- --dry-run            показать, что уйдёт, ничего не отправляя
 *   npm run send:curated                         отправить все 167 карточек (новые сверху)
 *   npm run send:curated -- --source=sknews.kz   только карточки одного издания
 *   npm run send:curated -- --id=17.13           ровно одну карточку
 *   npm run send:curated -- --limit=10           первые N карточек
 */

const args = process.argv.slice(2);
const flag = (name: string): string | undefined =>
  args.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');

const DRY_RUN = args.includes('--dry-run');
const SOURCE = flag('source');
const ID = flag('id');
const LIMIT = flag('limit') ? Number(flag('limit')) : undefined;
/** Пауза между сообщениями: Telegram разрешает примерно 30 сообщений в секунду, берём с запасом. */
const DELAY_MS = Number(flag('delay') ?? 1200);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function selectMentions(): CuratedMention[] {
  let list = getCuratedSortedByDate();
  if (ID) list = list.filter((m) => m.id === ID);
  if (SOURCE) list = list.filter((m) => m.sourceDomain === SOURCE.toLowerCase());
  if (LIMIT) list = list.slice(0, LIMIT);
  return list;
}

async function run(): Promise<void> {
  const list = selectMentions();
  if (list.length === 0) {
    console.error('Под фильтры не попало ни одной карточки. Всего в базе:', CURATED_MENTIONS.length);
    process.exit(1);
  }

  if (DRY_RUN) {
    for (const m of list) {
      console.log(`\n----- [${m.id}] -----\n${formatCuratedMessage(m)}`);
    }
    console.log(`\nDry run: было бы отправлено ${list.length} сообщений.`);
    return;
  }

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN не задан в .env');
  if (!chatId) throw new Error('TELEGRAM_CHAT_ID не задан в .env — см. npm run get-chat-id');

  const bot = new Telegraf(token);
  let sent = 0;

  for (const m of list) {
    try {
      await bot.telegram.sendMessage(chatId, formatCuratedMessage(m), {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
      });
      sent += 1;
      console.log(`отправлено [${m.id}] ${m.title}`);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.error(`ошибка на [${m.id}] ${m.url}: ${reason}`);
    }
    await sleep(DELAY_MS);
  }

  console.log(`\nГотово: отправлено ${sent} из ${list.length}.`);
}

run().catch((error) => {
  console.error('send:curated упал:', error);
  process.exit(1);
});
