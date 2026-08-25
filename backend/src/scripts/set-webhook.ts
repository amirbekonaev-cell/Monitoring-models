/**
 * One-off registration of the Telegram webhook — run this once per deploy of a new backend URL
 * (e.g. after the first Vercel deploy, or after a custom domain changes), NOT on every cold start:
 * TelegramBotService itself never calls setWebhook, exactly to avoid hitting Telegram's API on
 * every serverless invocation. Needs TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET in .env.
 *
 * Usage (from backend/): npm run set-webhook -- https://your-app.vercel.app
 * (or set TELEGRAM_WEBHOOK_BASE_URL in .env and run `npm run set-webhook` with no argument)
 */
import { config } from 'dotenv';
import { Telegraf } from 'telegraf';
config();

async function main(): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.error('TELEGRAM_BOT_TOKEN не задан в .env — впишите токен от @BotFather и запустите скрипт снова.');
    process.exit(1);
  }

  const secretToken = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!secretToken) {
    console.error(
      'TELEGRAM_WEBHOOK_SECRET не задан в .env — придумайте случайную строку, впишите её в .env ' +
        'и в переменные окружения Vercel, затем запустите скрипт снова.',
    );
    process.exit(1);
  }

  const baseUrl = (process.argv[2] || process.env.TELEGRAM_WEBHOOK_BASE_URL || '').trim().replace(/\/+$/, '');
  if (!baseUrl) {
    console.error(
      'Укажите базовый URL backend: npm run set-webhook -- https://your-app.vercel.app ' +
        '(или задайте TELEGRAM_WEBHOOK_BASE_URL в .env).',
    );
    process.exit(1);
  }

  const webhookUrl = `${baseUrl}/telegram/webhook`;
  const bot = new Telegraf(token);

  console.log(`Регистрирую вебхук: ${webhookUrl}`);
  await bot.telegram.setWebhook(webhookUrl, { secret_token: secretToken });

  const info = await bot.telegram.getWebhookInfo();
  console.log('Готово. Текущее состояние вебхука:', info);
}

main().catch((error) => {
  console.error('Ошибка:', error);
  process.exit(1);
});
