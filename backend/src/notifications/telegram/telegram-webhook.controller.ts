import { Body, Controller, ForbiddenException, Headers, HttpCode, Post } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Update } from 'telegraf/types';
import { TelegramBotService } from './telegram-bot.service';

/**
 * Telegram calls this once per update instead of the old long-poll loop (bot.launch()) — see
 * TelegramBotService for why: a Vercel Function instance is frozen/torn down after each request
 * (scale-to-zero), so nothing can hold a persistent getUpdates connection open. Registered once via
 * `npm run set-webhook` (src/scripts/set-webhook.ts), not on every cold start.
 */
@Controller('telegram')
export class TelegramWebhookController {
  constructor(
    private readonly config: ConfigService,
    private readonly telegramBotService: TelegramBotService,
  ) {}

  @Post('webhook')
  @HttpCode(200)
  async handleWebhook(
    @Body() update: Update,
    @Headers('x-telegram-bot-api-secret-token') secretToken: string | undefined,
  ): Promise<{ ok: true }> {
    const expectedSecret = this.config.get<string>('telegramBot.webhookSecret');
    // Rejected before touching handleUpdate() at all — an unauthenticated caller must never be
    // able to feed arbitrary "updates" (e.g. a forged /search from an attacker-controlled chat_id)
    // into the bot just by knowing the (public, guessable-from-source) webhook path.
    if (!expectedSecret || secretToken !== expectedSecret) {
      throw new ForbiddenException('Invalid webhook secret');
    }

    await this.telegramBotService.handleUpdate(update);
    return { ok: true };
  }
}
