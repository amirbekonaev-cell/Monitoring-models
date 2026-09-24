import type { TelegramBotMode } from './telegram-bot.service';

/**
 * Picks the transport the bot uses to receive updates (see TelegramBotService for what each one
 * means).
 *
 * The default has to differ per environment, because neither transport works in both places:
 * a webhook can never be delivered to the local docker compose stand (Telegram cannot reach
 * localhost), and a getUpdates loop cannot survive on Vercel (the Function instance is frozen
 * between requests). Vercel sets VERCEL=1 in every runtime environment itself, so the deploy
 * keeps its webhook with no extra variable to remember, while a local `docker compose up` gets
 * a bot that actually answers. TELEGRAM_BOT_MODE overrides the guess in either direction —
 * e.g. polling against a real tunnel-less staging box, or webhook behind an ngrok URL.
 */
export function resolveTelegramBotMode(
  rawMode: string | undefined,
  isServerless: boolean,
): TelegramBotMode {
  const normalized = (rawMode || '').trim().toLowerCase();
  if (normalized === 'webhook' || normalized === 'polling') {
    return normalized;
  }
  return isServerless ? 'webhook' : 'polling';
}
