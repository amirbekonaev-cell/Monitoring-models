/**
 * One-off helper: run this after you've (1) created a Telegram group, (2) added the bot to it,
 * (3) made the bot an admin, and (4) sent at least one message in the group. It reads recent
 * updates via the Bot API's getUpdates and prints the chat_id of any group/supergroup it saw,
 * so you can copy it into .env as TELEGRAM_CHAT_ID. See docs/telegram-setup.md for the full flow.
 *
 * Usage (from backend/): npm run get-chat-id
 */
import { config } from 'dotenv';
config();

interface TelegramChat {
  id: number;
  title?: string;
  type: string;
}

interface TelegramUpdate {
  message?: { chat: TelegramChat };
  channel_post?: { chat: TelegramChat };
}

interface GetUpdatesResponse {
  ok: boolean;
  description?: string;
  result?: TelegramUpdate[];
}

async function main(): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.error('TELEGRAM_BOT_TOKEN не задан в .env — впишите токен от @BotFather и запустите скрипт снова.');
    process.exit(1);
  }

  console.log('Опрашиваю Telegram getUpdates...');
  const res = await fetch(`https://api.telegram.org/bot${token}/getUpdates`);
  const data = (await res.json()) as GetUpdatesResponse;

  if (!data.ok) {
    console.error('Telegram API вернул ошибку:', data.description ?? '(нет описания)');
    process.exit(1);
  }

  const chats = new Map<string, { title: string; type: string }>();
  for (const update of data.result ?? []) {
    const chat = update.message?.chat ?? update.channel_post?.chat;
    if (chat && (chat.type === 'group' || chat.type === 'supergroup')) {
      chats.set(String(chat.id), { title: chat.title ?? '(без названия)', type: chat.type });
    }
  }

  if (chats.size === 0) {
    console.log(
      [
        'Групповых чатов не найдено. Проверьте:',
        '  1) бот действительно добавлен в группу и назначен администратором;',
        '  2) после этого в группе отправлено хотя бы одно новое сообщение;',
        '  3) с момента отправки прошло не больше суток (Telegram хранит getUpdates ~24 часа).',
        'Затем отправьте ещё одно сообщение в группу и запустите скрипт снова.',
      ].join('\n'),
    );
    return;
  }

  console.log('\nНайденные группы:');
  for (const [chatId, info] of chats) {
    console.log(`  chat_id=${chatId}  title="${info.title}"  type=${info.type}`);
  }
  console.log('\nСкопируйте нужный chat_id в .env как TELEGRAM_CHAT_ID и перезапустите docker compose.');
}

main().catch((error) => {
  console.error('Ошибка:', error);
  process.exit(1);
});