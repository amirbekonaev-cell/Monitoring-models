import { resolveTelegramBotMode } from './telegram-bot-mode.util';

describe('resolveTelegramBotMode', () => {
  it('defaults to polling off a serverless platform — Telegram cannot POST to localhost', () => {
    expect(resolveTelegramBotMode(undefined, false)).toBe('polling');
    expect(resolveTelegramBotMode('', false)).toBe('polling');
  });

  it('defaults to webhook on Vercel — a frozen Function instance cannot hold getUpdates open', () => {
    expect(resolveTelegramBotMode(undefined, true)).toBe('webhook');
  });

  it('honours an explicit TELEGRAM_BOT_MODE in either direction', () => {
    expect(resolveTelegramBotMode('webhook', false)).toBe('webhook');
    expect(resolveTelegramBotMode('polling', true)).toBe('polling');
    expect(resolveTelegramBotMode('  WEBHOOK  ', false)).toBe('webhook');
  });

  it('falls back to the platform default on an unrecognised value instead of failing silently', () => {
    expect(resolveTelegramBotMode('longpoll', false)).toBe('polling');
    expect(resolveTelegramBotMode('longpoll', true)).toBe('webhook');
  });
});
