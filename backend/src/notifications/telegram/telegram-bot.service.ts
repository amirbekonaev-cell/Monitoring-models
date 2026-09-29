import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Context, Markup, Telegraf } from 'telegraf';
import { InlineKeyboardMarkup, Update } from 'telegraf/types';
import { CuratedSearchService, CuratedSearchResult } from '../../curated/curated-search.service';
import { searchPeriodLabel } from '../../curated/search-period.util';
import {
  EMPTY_POOL_TEXT,
  SEARCH_PERIOD_PROMPT_TEXT,
  buildEmptyPeriodText,
  buildHeader,
  buildPage,
  buildPeriodConfirmationText,
  buildSearchMoreCallbackData,
  buildSearchInProgressText,
  buildSearchPeriodCallbackData,
  buildStatusText,
} from '../../curated/curated-message.util';

/** How many curated mentions to pull per fetch — comfortably more than could ever fit under one
 *  message's char limit (see buildPage's greedy packing), so a single findPage() call is enough
 *  to build one page; the pool itself is only ever a few hundred links. */
const PAGE_FETCH_BATCH_SIZE = 500;

/** How the bot receives updates — see the class comment and resolveTelegramBotMode(). */
export type TelegramBotMode = 'polling' | 'webhook';

/**
 * Owns the single Telegraf bot instance for the whole app — both inbound commands (/status,
 * /search) and outbound alerts (via getBot(), used by TelegramNotifierService) share it.
 *
 * Two transports, because the app runs in two very different places:
 *  - `webhook` — Telegram POSTs each update to TelegramWebhookController, which calls
 *    handleUpdate(). Required on Vercel: a Function instance is frozen/torn down between
 *    requests (scale-to-zero), so nothing can keep a getUpdates connection open across that.
 *  - `polling` — the bot itself pulls updates (bot.launch()). Required on the local docker
 *    compose stand: Telegram cannot reach http://localhost:3000, so a webhook can never be
 *    delivered there and the bot would silently answer nothing at all.
 * Default: polling everywhere except Vercel (which sets VERCEL=1 itself); TELEGRAM_BOT_MODE
 * overrides it explicitly. See resolveMode() and README "Телеграм-бот: webhook или polling".
 *
 * /status is a pure DB read over the closed pool of pre-vetted links (see CuratedSearchService).
 * /search reads the same pool, but when CURATED_LAZY_PROCESS is on it first does real work:
 * downloading still-unprocessed pool pages, extracting their dates and classifying tone through
 * OpenAI, bounded by CURATED_LAZY_BUDGET_MS. That is why the period handler posts a status line
 * before calling search() — see buildSearchInProgressText. It still never crawls the web for new
 * links: the pool is closed, and nothing here may claim otherwise to the user.
 */
@Injectable()
export class TelegramBotService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TelegramBotService.name);
  private bot: Telegraf | null = null;
  private polling = false;

  constructor(
    private readonly config: ConfigService,
    private readonly curatedSearchService: CuratedSearchService,
  ) {}

  private get periodDays(): number[] {
    return this.config.get<number[]>('curated.periodDays') ?? [];
  }

  private get timezone(): string {
    return this.config.get<string>('curated.timezone') || 'Asia/Almaty';
  }

  private get charLimit(): number {
    return this.config.get<number>('curated.messageCharLimit') || 3500;
  }

  private get mode(): TelegramBotMode {
    return this.config.get<TelegramBotMode>('telegramBot.mode') === 'webhook' ? 'webhook' : 'polling';
  }

  /**
   * Builds the Telegraf instance and registers the command/action handlers, then — in polling
   * mode only — opens the getUpdates loop so the bot actually receives anything on a stand
   * Telegram cannot call back into (localhost). In webhook mode nothing is launched: updates
   * arrive through TelegramWebhookController, and registering the webhook URL with Telegram
   * stays a separate one-time step (`npm run set-webhook`) — doing it on every cold start would
   * hit Telegram's API on every request and race across concurrent instances for no benefit.
   */
  async onModuleInit(): Promise<void> {
    const token = this.config.get<string>('telegramBot.token');
    if (!token) {
      this.logger.warn('TELEGRAM_BOT_TOKEN не задан — команды /status, /search недоступны, отправка уведомлений тоже работать не будет.');
      return;
    }

    // Without a chat id every command is rejected by isAuthorizedChat() and the bot looks dead
    // from inside the group — say so once at startup instead of only logging one warning per
    // ignored message.
    if (!this.config.get<string>('telegramBot.chatId')) {
      this.logger.warn(
        'TELEGRAM_CHAT_ID не задан — бот запустится, но отклонит любую команду как «не из рабочей группы». ' +
          'Получите chat_id через `npm run get-chat-id` и впишите его в .env (см. docs/telegram-setup.md).',
      );
    }

    this.bot = new Telegraf(token);
    this.registerCommands(this.bot);
    // Safety net: a handler that throws must not take the rest of the bot down with it — with a
    // single shared webhook endpoint, an unhandled rejection here would otherwise surface as a
    // 500 back to Telegram for every future update too, not just the one that failed.
    this.bot.catch((error, ctx) => {
      this.logger.error(
        `Необработанная ошибка при обработке апдейта Telegram (update_id=${ctx.update.update_id}): ${describeError(error)}`,
      );
    });

    try {
      await this.bot.telegram.setMyCommands([
        { command: 'status', description: 'Статистика пула ссылок' },
        { command: 'search', description: 'Упоминания из пула ссылок за период' },
      ]);
    } catch (error) {
      this.logger.warn(`Не удалось задать список команд бота (не критично): ${describeError(error)}`);
    }

    if (this.mode === 'webhook') {
      this.logger.log('Telegram-бот готов принимать вебхуки (POST /telegram/webhook): /status, /search');
      return;
    }

    await this.startPolling(this.bot);
  }

  /**
   * launch() resolves only when the bot stops, so it must never be awaited here — awaiting it
   * would hang Nest's bootstrap forever and the HTTP server would never start listening. We wait
   * on the onLaunch callback instead (fired right after getMe() succeeds) so an invalid token
   * surfaces as a clear error at startup rather than as silence.
   */
  private async startPolling(bot: Telegraf): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      // dropPendingUpdates: whatever piled up while the stand was down is stale by definition —
      // /search results for a period that has since moved on are worse than no answer.
      bot
        .launch({ dropPendingUpdates: true }, () => {
          this.polling = true;
          this.logger.log('Telegram-бот запущен в режиме long polling: /status, /search');
          resolve();
        })
        .then(() => {
          this.polling = false;
        })
        .catch((error) => {
          this.polling = false;
          this.logger.error(`Telegram-бот не смог запустить long polling: ${describeError(error)}`);
          reject(error instanceof Error ? error : new Error(String(error)));
        });
    }).catch(() => {
      // Already logged above. A bot that can't start must not take the whole backend (collectors,
      // REST API, frontend) down with it — the rest of the stand stays up.
    });
  }

  /** Closes the getUpdates loop on shutdown (app.enableShutdownHooks() in main.ts). */
  async onModuleDestroy(): Promise<void> {
    if (!this.bot || !this.polling) {
      return;
    }
    this.polling = false;
    try {
      this.bot.stop('shutdown');
    } catch (error) {
      this.logger.warn(`Не удалось корректно остановить long polling: ${describeError(error)}`);
    }
  }

  /** Used by TelegramWebhookController to dispatch one incoming Telegram update. */
  async handleUpdate(update: Update): Promise<void> {
    if (!this.bot) {
      throw new Error('TELEGRAM_BOT_TOKEN не задан в .env — получите токен у @BotFather');
    }
    await this.bot.handleUpdate(update);
  }

  /** Used by TelegramNotifierService to send outbound alerts through this same bot instance. */
  getBot(): Telegraf {
    if (!this.bot) {
      throw new Error('TELEGRAM_BOT_TOKEN не задан в .env — получите токен у @BotFather');
    }
    return this.bot;
  }

  /**
   * Restricting management commands to messages from our own configured group (TELEGRAM_CHAT_ID)
   * — rather than maintaining a separate admin user_id allow-list — because we already dedicate
   * one specific group to this bot; anyone who is a member of that (presumably small, trusted)
   * group can manage collection, with no extra config to keep in sync. A per-user_id list would
   * need the admin to look up numeric Telegram IDs and add each one by hand for a security
   * property (only *some* members can act) this project doesn't ask for — chat scoping already
   * blocks the concrete threat named in the brief (a stranger DMing the bot).
   */
  private isAuthorizedChat(chatId: number | string | undefined): boolean {
    const configuredChatId = this.config.get<string>('telegramBot.chatId');
    if (!configuredChatId || chatId === undefined || chatId === null) {
      return false;
    }
    return String(chatId) === configuredChatId;
  }

  private registerCommands(bot: Telegraf): void {
    bot.command('status', async (ctx) => {
      if (!this.isAuthorizedChat(ctx.chat?.id)) {
        await this.rejectUnauthorized(ctx);
        return;
      }
      const pool = await this.curatedSearchService.getPoolStats();
      await ctx.reply(buildStatusText(pool, this.timezone));
    });

    bot.command('search', async (ctx) => {
      if (!this.isAuthorizedChat(ctx.chat?.id)) {
        await this.rejectUnauthorized(ctx);
        return;
      }
      const rows = chunkArray(this.periodDays, 3).map((row) =>
        row.map((days) => Markup.button.callback(searchPeriodLabel(days), buildSearchPeriodCallbackData(days))),
      );
      await ctx.reply(SEARCH_PERIOD_PROMPT_TEXT, Markup.inlineKeyboard(rows));
    });

    bot.action(/^search_period:(\d+)$/, async (ctx) => {
      if (!this.isAuthorizedChat(ctx.chat?.id)) {
        await ctx.answerCbQuery('Эта команда доступна только в рабочей группе мониторинга.');
        return;
      }

      const days = parseInt((ctx.match as RegExpMatchArray)[1], 10);
      if (!this.periodDays.includes(days)) {
        await ctx.answerCbQuery('Неизвестный период');
        return;
      }

      await ctx.answerCbQuery();
      const label = searchPeriodLabel(days);
      const chatId = ctx.chat?.id;
      if (chatId === undefined) {
        return;
      }

      // Status first, work second: search() below is not an instant DB read when the
      // CURATED_LAZY_PROCESS pass is on — it downloads still-unprocessed pool pages and classifies
      // their tone through OpenAI before reading (up to CURATED_LAZY_BUDGET_MS). Without this the
      // chat shows nothing at all for those seconds and looks like the button did nothing.
      try {
        await ctx.editMessageText(buildSearchInProgressText(label));
      } catch (error) {
        // Purely cosmetic — never let a failed status edit stop the actual search below.
        this.logger.warn(`Не удалось показать статус поиска: ${describeError(error)}`);
      }

      try {
        const now = new Date();
        const result = await this.curatedSearchService.search(days, now);
        await ctx.editMessageText(buildPeriodConfirmationText(label, result.dateFrom, result.dateTo, result.processedNow));
        await this.sendFirstResultsPage(ctx.telegram, chatId, days, label, result, now);
      } catch (error) {
        await this.replyWithSearchError(ctx.telegram, chatId, error);
      }
    });

    bot.action(/^search_more:(\d+):(\d+)$/, async (ctx) => {
      if (!this.isAuthorizedChat(ctx.chat?.id)) {
        await ctx.answerCbQuery('Эта команда доступна только в рабочей группе мониторинга.');
        return;
      }

      const match = ctx.match as RegExpMatchArray;
      const days = parseInt(match[1], 10);
      const offset = parseInt(match[2], 10);
      if (!this.periodDays.includes(days) || !Number.isInteger(offset) || offset < 0) {
        await ctx.answerCbQuery('Некорректный запрос');
        return;
      }

      await ctx.answerCbQuery();
      const chatId = ctx.chat?.id;
      if (chatId === undefined) {
        return;
      }

      // Best-effort — a message too old to edit (or already stripped) must not block sending the
      // next page.
      try {
        await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
      } catch (error) {
        this.logger.warn(`Не удалось снять клавиатуру с предыдущего сообщения /search: ${describeError(error)}`);
      }

      try {
        const now = new Date();
        const label = searchPeriodLabel(days);
        const result = await this.curatedSearchService.search(days, now);
        const items = await this.curatedSearchService.findPage(days, offset, PAGE_FETCH_BATCH_SIZE, now);
        const { text, shownCount } = buildPage({
          header: null,
          items,
          startIndex: offset + 1,
          timezone: this.timezone,
          charLimit: this.charLimit,
        });

        if (shownCount === 0) {
          await ctx.telegram.sendMessage(chatId, 'Больше записей нет.');
          return;
        }

        const remaining = result.total - (offset + shownCount);
        const replyMarkup = remaining > 0 ? this.buildMoreKeyboard(days, offset + shownCount, remaining) : undefined;
        await ctx.telegram.sendMessage(chatId, text, {
          parse_mode: 'HTML',
          link_preview_options: { is_disabled: true },
          ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
        });
      } catch (error) {
        await this.replyWithSearchError(ctx.telegram, chatId, error);
      }
    });
  }

  private async sendFirstResultsPage(
    telegram: Telegraf['telegram'],
    chatId: number,
    days: number,
    label: string,
    result: CuratedSearchResult,
    now: Date,
  ): Promise<void> {
    if (result.pool.totalLinks === 0 || result.pool.mentionsTotal === 0) {
      await telegram.sendMessage(chatId, EMPTY_POOL_TEXT);
      return;
    }

    if (result.total === 0) {
      await telegram.sendMessage(chatId, buildEmptyPeriodText(label, result, this.timezone));
      return;
    }

    const header = buildHeader(label, result);
    const items = await this.curatedSearchService.findPage(days, 0, PAGE_FETCH_BATCH_SIZE, now);
    const { text, shownCount } = buildPage({ header, items, startIndex: 1, timezone: this.timezone, charLimit: this.charLimit });
    const remaining = result.total - shownCount;
    const replyMarkup = remaining > 0 ? this.buildMoreKeyboard(days, shownCount, remaining) : undefined;

    await telegram.sendMessage(chatId, text, {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    });
  }

  private buildMoreKeyboard(days: number, offset: number, remaining: number): InlineKeyboardMarkup | undefined {
    const callbackData = buildSearchMoreCallbackData(days, offset);
    if (!callbackData) {
      this.logger.error(
        `callback_data для кнопки "Показать ещё" превысил 64 байта (days=${days}, offset=${offset}) — кнопка не показана`,
      );
      return undefined;
    }
    return Markup.inlineKeyboard([Markup.button.callback(`Показать ещё (осталось ${remaining})`, callbackData)]).reply_markup;
  }

  private async replyWithSearchError(
    telegram: Telegraf['telegram'],
    chatId: number | string | undefined,
    error: unknown,
  ): Promise<void> {
    if (chatId === undefined) {
      return;
    }
    const reason = describeError(error);
    this.logger.error(`/search (пул ссылок) завершился ошибкой: ${reason}`);
    await telegram.sendMessage(chatId, `Не удалось выполнить поиск по пулу ссылок: ${reason}`);
  }

  private async rejectUnauthorized(ctx: Context): Promise<void> {
    this.logger.warn(`Отклонена команда из неавторизованного чата (chat_id=${ctx.chat?.id})`);
    await ctx.reply('Эта команда доступна только в рабочей группе мониторинга.');
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}
