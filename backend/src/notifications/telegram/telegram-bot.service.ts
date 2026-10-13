import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Context, Markup, Telegraf } from 'telegraf';
import { Sentiment } from '../../mentions/mention.entity';
import { InlineKeyboardMarkup, Update } from 'telegraf/types';
import {
  CURATED_SEARCH_SOURCE,
  CuratedMentionView,
  CuratedSearchResult,
  CuratedSearchSource,
} from '../../curated/curated-search.types';
import { CuratedResetService } from '../../curated/curated-reset.service';
import { DashboardPublishService } from '../../curated/dashboard-publish.service';
import { CuratedMentionsService } from '../../curated/curated-mentions.service';
import { CuratedMention } from '../../curated/curated-mentions';
import { searchPeriodLabel } from '../../curated/search-period.util';
import { buildSearchProgressText, planSearchProgress } from '../../curated/search-progress.util';
import { LiveSearchOutcome, LiveSearchService } from '../../live-search/live-search.service';
import { LiveFindStoreService } from '../../live-search/live-find-store.service';
import { filterFindsToPeriod } from '../../live-search/live-find-period.util';
import { liveFindToMentionView } from '../../live-search/live-find.types';
import {
  CURATED_MENTIONS_BATCH_SIZE,
  buildCuratedMoreCallbackData,
  buildCuratedSourceHeader,
  buildCuratedSourceUsageText,
  buildCuratedStatsText,
  parseCuratedMoreCallbackData,
} from '../../curated/curated-mentions-message.util';
import {
  DashboardPublishNote,
  EMPTY_POOL_TEXT,
  RESET_CANCELLED_TEXT,
  RESET_CANCEL_CALLBACK_DATA,
  RESET_CONFIRM_CALLBACK_DATA,
  RESET_NOTHING_TEXT,
  SEARCH_EXPAND_DECLINED_TEXT,
  SEARCH_EXPAND_DECLINE_CALLBACK_DATA,
  SEARCH_EXPAND_NO_TEXT,
  SEARCH_EXPAND_YES_TEXT,
  SEARCH_PERIOD_PROMPT_TEXT,
  buildResetConfirmText,
  buildResetDoneText,
  buildEmptyPeriodText,
  buildExpandPromptText,
  buildHeader,
  buildItemMessages,
  buildMoreButtonFallbackText,
  buildPage,
  buildPeriodConfirmationText,
  buildSearchExpandCallbackData,
  buildSearchMoreCallbackData,
  buildSearchInProgressText,
  buildSearchPeriodCallbackData,
  buildStatusText,
  buildTitleListMessages,
} from '../../curated/curated-message.util';

/** How many curated mentions to pull per fetch — comfortably more than could ever fit under one
 *  message's char limit (see buildPage's greedy packing), so a single findPage() call is enough
 *  to build one page; the pool itself is only ever a few hundred links. */
const PAGE_FETCH_BATCH_SIZE = 500;

/**
 * Pause between two consecutive messages in one-article-per-message mode. Telegram rate-limits a
 * bot to roughly 20 messages/minute into a single group, and exceeding it earns a 429 for the
 * whole batch rather than a slower delivery. 700 ms keeps a default batch (8) at ~5s of waiting —
 * comfortably inside the 60s ceiling the Vercel invocation has, which is the other half of why
 * the batch is capped (see buildItemMessages).
 */
const ONE_PER_MESSAGE_DELAY_MS = 700;

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
 * /status and /search both read CURATED_SEARCH_SOURCE, bound to CuratedJsonSearchService: the
 * ready-made cards in curated-mentions.data.json, already carrying title, date, summary and
 * sentiment. Both commands are therefore in-memory filters that answer immediately — no DB query,
 * no page download, no OpenAI call anywhere in the path, and the bot runs with no OPENAI_API_KEY
 * in the environment at all. The dependency is the interface, not CuratedSearchService: this class
 * has no way to reach CuratedIngestService, CuratedOpenAiReaderService or OpenAiWebSearchService,
 * and that is the property to preserve — it is what keeps /search fast and keeps it working when
 * a third-party API is down. It never crawls the web for new links either: the set is closed, and
 * nothing here may claim otherwise to the user.
 */
@Injectable()
export class TelegramBotService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TelegramBotService.name);
  private bot: Telegraf | null = null;
  private polling = false;

  constructor(
    private readonly config: ConfigService,
    @Inject(CURATED_SEARCH_SOURCE)
    private readonly curatedSearchService: CuratedSearchSource,
    private readonly curatedResetService: CuratedResetService,
    private readonly curatedMentionsService: CuratedMentionsService,
    private readonly dashboardPublishService: DashboardPublishService,
    private readonly liveSearchService: LiveSearchService,
    private readonly liveFindStore: LiveFindStoreService,
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

  /** SEARCH_ONE_ARTICLE_PER_MESSAGE — false (default) keeps the packed-page output byte for byte. */
  private get oneArticlePerMessage(): boolean {
    return this.config.get<boolean>('curated.oneArticlePerMessage') === true;
  }

  /** SEARCH_ITEMS_PER_BATCH — how many separate article messages one button press sends. */
  private get itemsPerBatch(): number {
    const value = this.config.get<number>('curated.itemsPerBatch');
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 8;
  }

  /**
   * SEARCH_MIN_DURATION_MS — сколько /search как минимум держит человека в ожидании, прежде чем
   * отдать первую страницу. 0 — отдавать сразу (прежнее поведение). См. search-progress.util.ts.
   */
  private get searchMinDurationMs(): number {
    const value = this.config.get<number>('curated.minDurationMs');
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
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
      // Ровно три команды в меню. /curated_stats и /curated из него убраны намеренно: они дублируют
      // то, что теперь делает /search (список найденного, затем статьи по одной со ссылкой), и
      // только засоряли меню. Сами обработчики ниже оставлены — их можно вызвать, набрав команду
      // руками, и кнопки в уже отправленных сообщениях продолжают работать.
      await this.bot.telegram.setMyCommands([
        { command: 'search', description: 'Упоминания за период: список, затем статьи по одной' },
        { command: 'status', description: 'Статистика пула ссылок' },
        { command: 'reset', description: 'Сбросить пул: удалить упоминания, вернуть ссылки в очередь' },
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

    // Destructive, so it is two steps: /reset only ever shows what would be lost, and nothing is
    // touched until the confirm button below is pressed. Same chat restriction as everything else
    // (isAuthorizedChat) — this must not be reachable by a stranger who DMs the bot.
    bot.command('reset', async (ctx) => {
      if (!this.isAuthorizedChat(ctx.chat?.id)) {
        await this.rejectUnauthorized(ctx);
        return;
      }

      const preview = await this.curatedResetService.preview();
      if (preview.links === 0) {
        await ctx.reply(RESET_NOTHING_TEXT);
        return;
      }

      await ctx.reply(buildResetConfirmText(preview), {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('Да, сбросить', RESET_CONFIRM_CALLBACK_DATA)],
          [Markup.button.callback('Отмена', RESET_CANCEL_CALLBACK_DATA)],
        ]),
      });
    });

    bot.action(RESET_CANCEL_CALLBACK_DATA, async (ctx) => {
      if (!this.isAuthorizedChat(ctx.chat?.id)) {
        await ctx.answerCbQuery('Эта команда доступна только в рабочей группе мониторинга.');
        return;
      }
      await ctx.answerCbQuery();
      await ctx.editMessageText(RESET_CANCELLED_TEXT);
    });

    bot.action(RESET_CONFIRM_CALLBACK_DATA, async (ctx) => {
      if (!this.isAuthorizedChat(ctx.chat?.id)) {
        await ctx.answerCbQuery('Эта команда доступна только в рабочей группе мониторинга.');
        return;
      }
      await ctx.answerCbQuery();

      try {
        const outcome = await this.curatedResetService.reset();
        await ctx.editMessageText(buildResetDoneText(outcome));
      } catch (error) {
        const reason = describeError(error);
        this.logger.error(`Сброс пула из Telegram не удался: ${reason}`);
        await ctx.editMessageText(`Не удалось сбросить пул: ${reason}`);
      }
    });

    // Вручную проверенные карточки — отдельный набор от закрытого пула (/status, /search).
    // Бот здесь ничего не генерирует и не ходит в LLM: весь текст написан человеком и лежит в
    // curated-mentions.data.json.
    bot.command('curated_stats', async (ctx) => {
      if (!this.isAuthorizedChat(ctx.chat?.id)) {
        await this.rejectUnauthorized(ctx);
        return;
      }
      const domainsByName = new Map(this.curatedMentionsService.all().map((m) => [m.sourceName, m.sourceDomain]));
      await ctx.reply(buildCuratedStatsText(this.curatedMentionsService.stats(), domainsByName), {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
      });
    });

    bot.command('curated', async (ctx) => {
      if (!this.isAuthorizedChat(ctx.chat?.id)) {
        await this.rejectUnauthorized(ctx);
        return;
      }

      const domain = (ctx.message as { text?: string } | undefined)?.text?.trim().split(/\s+/)[1]?.toLowerCase() ?? null;
      const items = domain ? this.curatedSelection(domain) : [];
      if (items.length === 0) {
        await ctx.reply(buildCuratedSourceUsageText(domain, this.curatedDomains()), {
          parse_mode: 'HTML',
          link_preview_options: { is_disabled: true },
        });
        return;
      }

      const chatId = ctx.chat?.id;
      if (chatId === undefined) {
        return;
      }
      await this.sendCuratedBatch(ctx.telegram, chatId, domain as string, items, 0);
    });

    bot.action(/^curated_more:.+:\d+$/, async (ctx) => {
      if (!this.isAuthorizedChat(ctx.chat?.id)) {
        await ctx.answerCbQuery('Эта команда доступна только в рабочей группе мониторинга.');
        return;
      }

      const parsed = parseCuratedMoreCallbackData((ctx.match as RegExpMatchArray)[0]);
      if (!parsed) {
        await ctx.answerCbQuery('Некорректный запрос');
        return;
      }

      const items = this.curatedSelection(parsed.domain);
      if (items.length === 0) {
        await ctx.answerCbQuery('Издание не найдено');
        return;
      }

      await ctx.answerCbQuery();
      const chatId = ctx.chat?.id;
      if (chatId === undefined) {
        return;
      }

      // Снимаем клавиатуру с предыдущей пачки, чтобы её нельзя было нажать второй раз.
      try {
        await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
      } catch (error) {
        this.logger.warn(`Не удалось снять клавиатуру с предыдущей пачки карточек: ${describeError(error)}`);
      }

      await this.sendCuratedBatch(ctx.telegram, chatId, parsed.domain, items, parsed.offset);
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

      // Отсчёт темпа выдачи начинается здесь, с нажатия кнопки, а не после фильтрации набора:
      // всё, что успеет сделаться само (фильтр, запись дашборда), идёт В СЧЁТ ожидания, а не
      // сверх него. Иначе минимальная длительность складывалась бы с реальной работой и вызов
      // подходил бы к 60-секундному потолку Vercel без всякой необходимости.
      const startedAt = Date.now();

      // Первый кадр: заменяет клавиатуру периодов строкой с названием периода. Дальше его
      // перерисовывает showSearchProgress (счётчик), а в самом конце — подтверждение окна.
      try {
        await ctx.editMessageText(buildSearchInProgressText(label));
      } catch (error) {
        // Purely cosmetic — never let a failed status edit stop the actual search below.
        this.logger.warn(`Не удалось показать статус поиска: ${describeError(error)}`);
      }

      try {
        const now = new Date();
        const result = await this.curatedSearchService.search(days, now);
        // Живой поиск запускается ЗДЕСЬ и не дожидается: он идёт параллельно с паузой темпа
        // выдачи (ленты ~3 с, веб-поиск 16–21 с — внутри 30 с ожидания), поэтому к длительности
        // /search не добавляет ничего. Ошибка внутри него уже обработана — см. startLiveSearch.
        const livePass = this.startLiveSearch(days, now);
        await this.showSearchProgress(ctx, label, startedAt);
        const live = await livePass;
        const liveViews = liveItems(live);
        // Находки кладутся в хранилище СРАЗУ, до отправки списка: разворот статей по одному
        // сообщению — это уже другое нажатие и другой вызов вебхука, и взять их там больше
        // негде. Повторить живой поиск нельзя — он платный и во второй раз отдаёт другой набор
        // (см. LiveFindStoreService).
        await this.storeLiveFinds(days, live, now);
        // Нажатая кнопка периода — единственное, что решает, какие материалы лежат в дашборде и
        // ленте веб-интерфейса: выдача за этот период заменяет там всё, что было раньше (см.
        // DashboardPublishService). Запись идёт здесь, а не после отправки сообщений, — иначе
        // сбой на отправке оставил бы в веб-интерфейсе прежний набор, — и уже ПОСЛЕ живого
        // поиска, чтобы в дашборд уехала та же выдача, что и в Telegram, вместе с находками.
        const dashboard = await this.publishToDashboard(days, now, liveViews);
        await ctx.editMessageText(buildPeriodConfirmationText(label, result.dateFrom, result.dateTo, dashboard));
        await this.sendFirstResultsPage(ctx.telegram, chatId, days, label, result, now, liveViews);
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

        if (this.oneArticlePerMessage) {
          const sent = await this.sendItemsOnePerMessage(
            ctx.telegram,
            chatId,
            days,
            await this.periodItems(days, result, now),
            offset,
          );
          if (sent === 0) {
            await ctx.telegram.sendMessage(chatId, 'Больше записей нет.');
          }
          return;
        }

        const periodItems = await this.periodItems(days, result, now);
        const { text, shownCount } = buildPage({
          header: null,
          items: periodItems.slice(offset, offset + PAGE_FETCH_BATCH_SIZE),
          startIndex: offset + 1,
          timezone: this.timezone,
          charLimit: this.charLimit,
        });

        if (shownCount === 0) {
          await ctx.telegram.sendMessage(chatId, 'Больше записей нет.');
          return;
        }

        const remaining = periodItems.length - (offset + shownCount);
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

    // «Нет» под вопросом о разворачивании. Отвечать нечем — список заголовков уже отправлен, —
    // поэтому только подтверждение и снятая клавиатура, чтобы вопрос не остался висеть открытым.
    bot.action(SEARCH_EXPAND_DECLINE_CALLBACK_DATA, async (ctx) => {
      if (!this.isAuthorizedChat(ctx.chat?.id)) {
        await ctx.answerCbQuery('Эта команда доступна только в рабочей группе мониторинга.');
        return;
      }

      await ctx.answerCbQuery();
      try {
        await ctx.editMessageText(SEARCH_EXPAND_DECLINED_TEXT);
      } catch (error) {
        this.logger.warn(`Не удалось закрыть вопрос о разворачивании: ${describeError(error)}`);
      }
    });

    // «Да, по одной» и её продолжение («Показать ещё» под последней статьёй): одна статья — одно
    // сообщение, с пересказом и ссылкой. Отдельная ветка от search_more, которая остаётся для
    // упакованных страниц и для кнопок в уже отправленных сообщениях.
    bot.action(/^search_each:(\d+):(\d+)$/, async (ctx) => {
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

      // Клавиатуру снимаем сразу: иначе «Да» или «Показать ещё» можно нажать второй раз и получить
      // те же статьи дважды.
      try {
        await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
      } catch (error) {
        this.logger.warn(`Не удалось снять клавиатуру с вопроса /search: ${describeError(error)}`);
      }

      try {
        const now = new Date();
        const result = await this.curatedSearchService.search(days, now);
        const sent = await this.sendItemsOnePerMessage(
          ctx.telegram,
          chatId,
          days,
          await this.periodItems(days, result, now),
          offset,
        );
        if (sent === 0) {
          await ctx.telegram.sendMessage(chatId, 'Больше записей нет.');
        }
      } catch (error) {
        await this.replyWithSearchError(ctx.telegram, chatId, error);
      }
    });
  }

  /**
   * ОДИН список материалов за период — то, из чего состоит и обзор заголовков, и разворот статей
   * по одному сообщению: найденное живым поиском и карточки набора вперемешку, по дате публикации.
   *
   * Отдельного блока «вот это я нашёл только что» нет намеренно: человек спрашивал упоминания за
   * период, а не отчёт о том, какими способами бот их собирал.
   *
   * `live` передаётся только в том вызове, который сам запускал живой поиск (нажатие периода). Во
   * всех остальных — «Да, по одной», «Показать ещё» — это уже другой вызов вебхука, от прежнего в
   * памяти не осталось ничего, и находки читаются из хранилища. Именно поэтому разворот
   * показывает те же статьи, что человек увидел в списке, вместе с пересказом и ссылкой: до
   * хранилища он собирал статьи заново из одного набора, и найденного живым поиском в нём не было.
   */
  private async periodItems(
    days: number,
    result: CuratedSearchResult,
    now: Date,
    live?: CuratedMentionView[],
  ): Promise<CuratedMentionView[]> {
    // Окно читается ЦЕЛИКОМ, а не страницей по смещению: порядок в общем списке задаёт дата, и
    // чтобы отдать страницу №3, надо сперва знать, где в нём встали находки. Для источника бота
    // это срез массива в памяти (CuratedJsonSearchService, карточки из JSON), так что лишней
    // работы здесь нет.
    const found = result.total > 0 ? await this.curatedSearchService.findPage(days, 0, result.total, now) : [];
    const liveViews = live ?? (await this.storedLiveItems(days, now));
    return [...liveViews, ...found].sort(byPublishedAtDesc);
  }

  /**
   * Находки последнего /search за период из хранилища.
   *
   * Окно периода отсчитывается от момента, когда находки были СОХРАНЕНЫ, а не от «сейчас»: иначе
   * статья на границе окна (поиск за неделю вечером, разворот после полуночи) исчезла бы из
   * сообщений, хотя в списке заголовков человек её только что видел. Фильтр при этом остаётся —
   * он же заново сверяет находки с набором карточек и отбрасывает дубли.
   *
   * Сбой базы — это пустой вклад и предупреждение, а не ошибка выдачи: человек получит статьи
   * набора, как получал их до появления хранилища. /search обязан отвечать и с недоступным
   * Postgres.
   */
  private async storedLiveItems(days: number, now: Date): Promise<CuratedMentionView[]> {
    try {
      const stored = await this.liveFindStore.load(days);
      return filterFindsToPeriod(stored.finds, days, stored.savedAt ?? now, this.timezone).map(liveFindToMentionView);
    } catch (error) {
      this.logger.warn(`Не удалось прочитать находки живого поиска за ${days} дн.: ${describeError(error)}`);
      return [];
    }
  }

  /**
   * Сохраняет находки, которыми только что дополнена выдача.
   *
   * Упавший живой поиск (`null`) сохраняется как ПУСТОЙ список, а не оставляет прежние находки:
   * список заголовков, который человек видит, в этот раз тоже без них, и разворот обязан
   * показать ровно то, что в списке, — иначе в сообщениях появились бы статьи из прошлого
   * нажатия.
   */
  private async storeLiveFinds(days: number, outcome: LiveSearchOutcome | null, now: Date): Promise<void> {
    try {
      await this.liveFindStore.save(days, outcome?.finds ?? [], now);
    } catch (error) {
      this.logger.warn(`Не удалось сохранить находки живого поиска за ${days} дн.: ${describeError(error)}`);
    }
  }

  /**
   * Запускает живой поиск и СРАЗУ отдаёт обещание, не дожидаясь его: поиск идёт параллельно с
   * паузой темпа выдачи, то есть внутри тех 30 секунд, которые /search и так ждёт. Благодаря
   * этому ожидание наполнено работой, а длительность вызова не растёт ни на миллисекунду.
   *
   * Любая ошибка гасится здесь же и превращается в `null`: найденное живым поиском дополняет
   * выдачу, и упавший канал не вправе превратить работающий /search в сообщение об ошибке. Это то
   * же правило, по которому живёт ленивая дообработка в CuratedSearchService.
   */
  private startLiveSearch(days: number, now: Date): Promise<LiveSearchOutcome | null> {
    return this.liveSearchService.collect(days, now).catch((error) => {
      this.logger.warn(`Живой поиск пропущен (выдача не затронута): ${describeError(error)}`);
      return null;
    });
  }

  /**
   * Держит сообщение-статус до истечения SEARCH_MIN_DURATION_MS, перерисовывая процент, и только
   * потом возвращает управление — выдача уходит после этого.
   *
   * Пауза не пустая: внутри неё параллельно идёт живой поиск (ленты и веб-поиск, см.
   * LiveSearchService), который как раз и укладывается в эти секунды. Поэтому ожидание — это
   * время работы, а не выдуманная задержка.
   *
   * В сообщении только период и процент. Сколько у бота материалов, откуда они и какими каналами
   * он пользуется — его внутреннее устройство, и человеку, который спросил про упоминания за
   * период, оно не нужно.
   *
   * Отсчёт идёт от `startedAt` (нажатия кнопки), поэтому уже потраченное на фильтр и запись
   * дашборда время входит в ожидание: общая длительность вызова равна SEARCH_MIN_DURATION_MS плюс
   * отправка сообщений. Сбой перерисовки проглатывается — это косметика, из-за неё выдача не
   * должна пропадать.
   */
  private async showSearchProgress(ctx: Context, label: string, startedAt: number): Promise<void> {
    const minDurationMs = this.searchMinDurationMs;
    if (minDurationMs <= 0) {
      return;
    }

    for (const step of planSearchProgress(minDurationMs)) {
      const waitMs = startedAt + step.atMs - Date.now();
      if (waitMs > 0) {
        await sleep(waitMs);
      }
      try {
        await ctx.editMessageText(buildSearchProgressText(label, step.percent));
      } catch (error) {
        this.logger.warn(`Не удалось обновить статус поиска: ${describeError(error)}`);
      }
    }

    const remainingMs = startedAt + minDurationMs - Date.now();
    if (remainingMs > 0) {
      await sleep(remainingMs);
    }
  }

  /**
   * Ответ на нажатую кнопку периода: СПИСОК всего найденного, затем вопрос о разворачивании.
   *
   * Два шага, а не сразу полные карточки, потому что за широкий период их сотни: сначала читатель
   * целиком видит, что нашлось и сколько (заголовок, дата, издание — по строке на материал), и
   * только потом решает, нужны ли пересказы со ссылками по одному сообщению на статью. Список
   * уходит ПОЛНОСТЬЮ, сколькими бы сообщениями он ни был — обрезать обзор нечем, иначе он
   * перестаёт быть обзором.
   *
   * SEARCH_ONE_ARTICLE_PER_MESSAGE=true пропускает вопрос и разворачивает сразу — для чата, где
   * его всегда подтверждают.
   */
  private async sendFirstResultsPage(
    telegram: Telegraf['telegram'],
    chatId: number,
    days: number,
    label: string,
    result: CuratedSearchResult,
    now: Date,
    live: CuratedMentionView[],
  ): Promise<void> {
    const merged = await this.periodItems(days, result, now, live);

    if (merged.length === 0) {
      await telegram.sendMessage(chatId, result.pool.mentionsTotal === 0 ? EMPTY_POOL_TEXT : buildEmptyPeriodText(label));
      return;
    }

    const mergedResult = withMergedTotals(result, merged);
    const messages = buildTitleListMessages({
      header: buildHeader(label, mergedResult),
      items: merged,
      startIndex: 1,
      timezone: this.timezone,
      charLimit: this.charLimit,
    });

    for (let i = 0; i < messages.length; i++) {
      if (i > 0) {
        await sleep(ONE_PER_MESSAGE_DELAY_MS);
      }
      await telegram.sendMessage(chatId, messages[i], {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
      });
    }

    if (this.oneArticlePerMessage) {
      await this.sendItemsOnePerMessage(telegram, chatId, days, merged, 0);
      return;
    }

    await this.sendExpandPrompt(telegram, chatId, days, mergedResult.total);
  }

  /** Вопрос «выводить ли каждую статью отдельным сообщением» с кнопками Да/Нет. */
  private async sendExpandPrompt(
    telegram: Telegraf['telegram'],
    chatId: number,
    days: number,
    total: number,
  ): Promise<void> {
    const yes = buildSearchExpandCallbackData(days, 0);
    if (yes === null) {
      // callback_data не влезло — спрашивать бессмысленно, кнопка всё равно не уедет.
      this.logger.warn(`Не удалось собрать кнопку разворачивания для периода ${days} дн.`);
      return;
    }

    await telegram.sendMessage(chatId, buildExpandPromptText(total), {
      reply_markup: Markup.inlineKeyboard([
        [Markup.button.callback(SEARCH_EXPAND_YES_TEXT, yes)],
        [Markup.button.callback(SEARCH_EXPAND_NO_TEXT, SEARCH_EXPAND_DECLINE_CALLBACK_DATA)],
      ]).reply_markup,
    });
  }

  /**
   * One batch of findings, one Telegram message each (SEARCH_ONE_ARTICLE_PER_MESSAGE=true).
   * Returns how many findings the batch covered — 0 means the offset is already past the end,
   * which the caller turns into "Больше записей нет.".
   *
   * Everything here is awaited inside the webhook invocation, like every other handler in this
   * class (see README "Почему обработчики бота дожидаются всего синхронно"): the batch size and
   * the pause between messages are chosen so the whole call fits the 60s ceiling with room to
   * spare, rather than being handed off to something that outlives the response.
   *
   * A failed send is logged (id and label only, never a URL) and the batch continues: losing one
   * article to a Telegram hiccup must not cost the reader the other seven, nor the button that
   * fetches the rest — which is why the keyboard falls back to its own carrier message when the
   * article message it was meant to ride on is the one that failed.
   */
  private async sendItemsOnePerMessage(
    telegram: Telegraf['telegram'],
    chatId: number,
    days: number,
    periodItems: CuratedMentionView[],
    offset: number,
  ): Promise<number> {
    const batchSize = this.itemsPerBatch;
    const { messages, nextOffset, remaining } = buildItemMessages({
      items: periodItems.slice(offset, offset + batchSize),
      startOffset: offset,
      total: periodItems.length,
      timezone: this.timezone,
      batchSize,
    });

    if (messages.length === 0) {
      return 0;
    }

    const replyMarkup = remaining > 0 ? this.buildEachMoreKeyboard(days, nextOffset, remaining) : undefined;
    let keyboardDelivered = replyMarkup === undefined;

    for (let i = 0; i < messages.length; i++) {
      if (i > 0) {
        await sleep(ONE_PER_MESSAGE_DELAY_MS);
      }
      const isLast = i === messages.length - 1;
      const markup = isLast && replyMarkup ? replyMarkup : undefined;
      try {
        await telegram.sendMessage(chatId, messages[i], {
          parse_mode: 'HTML',
          link_preview_options: { is_disabled: true },
          ...(markup ? { reply_markup: markup } : {}),
        });
        if (markup) {
          keyboardDelivered = true;
        }
      } catch (error) {
        this.logger.warn(
          `Не удалось отправить сообщение с находкой №${offset + i + 1} за период ${days} дн.: ${describeError(error)}`,
        );
      }
    }

    if (!keyboardDelivered && replyMarkup) {
      try {
        await telegram.sendMessage(chatId, buildMoreButtonFallbackText(nextOffset, periodItems.length), {
          reply_markup: replyMarkup,
        });
      } catch (error) {
        this.logger.warn(`Не удалось отправить кнопку "Показать ещё": ${describeError(error)}`);
      }
    }

    return messages.length;
  }

  /** Домены изданий набора, по одному разу, в алфавитном порядке — для подсказки в /curated. */
  private curatedDomains(): string[] {
    return [...new Set(this.curatedMentionsService.all().map((m) => m.sourceDomain))].sort();
  }

  /**
   * Что отправляет `/curated <аргумент>`: `all` — весь набор, новые сверху; иначе карточки
   * одного издания.
   *
   * `all` существует ради деплоя на Vercel: там нет ни шелла, ни расписания, поэтому
   * `npm run send:curated` запустить неоткуда, и выгрузить весь набор в чат можно только
   * командой бота. Домен `all` ни с чем не конфликтует — это не валидное имя хоста, и в
   * наборе такого издания нет (закреплено тестом).
   */
  private curatedSelection(argument: string): CuratedMention[] {
    return argument === 'all' ? this.curatedMentionsService.sortedByDate() : this.curatedMentionsService.bySource(argument);
  }

  /**
   * Одна пачка готовых карточек одного издания: заголовок, затем по сообщению на карточку.
   * Текст берётся из JSON как есть — бот его не собирает и не дополняет.
   *
   * Пачками, а не целиком, по той же причине, что и у /search (см. sendItemsOnePerMessage):
   * у sknews.kz 49 карточек, а Telegram пропускает в группу около 20 сообщений в минуту.
   * Сбой на одной карточке логируется и не прерывает пачку.
   */
  private async sendCuratedBatch(
    telegram: Telegraf['telegram'],
    chatId: number,
    domain: string,
    items: CuratedMention[],
    offset: number,
  ): Promise<void> {
    const batch = items.slice(offset, offset + CURATED_MENTIONS_BATCH_SIZE);
    if (batch.length === 0) {
      await telegram.sendMessage(chatId, 'Больше карточек нет.');
      return;
    }

    await telegram.sendMessage(chatId, buildCuratedSourceHeader(items, domain, offset), {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
    });

    const nextOffset = offset + batch.length;
    const remaining = items.length - nextOffset;
    const callbackData = remaining > 0 ? buildCuratedMoreCallbackData(domain, nextOffset) : null;
    const replyMarkup = callbackData
      ? Markup.inlineKeyboard([Markup.button.callback(`Показать ещё (осталось ${remaining})`, callbackData)]).reply_markup
      : undefined;

    for (let i = 0; i < batch.length; i++) {
      if (i > 0) {
        await sleep(ONE_PER_MESSAGE_DELAY_MS);
      }
      const isLast = i === batch.length - 1;
      try {
        await telegram.sendMessage(chatId, this.curatedMentionsService.formatMessage(batch[i]), {
          parse_mode: 'HTML',
          link_preview_options: { is_disabled: true },
          ...(isLast && replyMarkup ? { reply_markup: replyMarkup } : {}),
        });
      } catch (error) {
        this.logger.warn(`Не удалось отправить карточку [${batch[i].id}]: ${describeError(error)}`);
      }
    }
  }

  private buildMoreKeyboard(days: number, offset: number, remaining: number): InlineKeyboardMarkup | undefined {
    return this.buildContinueKeyboard(buildSearchMoreCallbackData(days, offset), days, offset, remaining);
  }

  /**
   * «Показать ещё» для потока «одна статья — одно сообщение»: продолжает ИМЕННО его (search_each),
   * а не упакованные страницы. Иначе нажатие после «Да, по одной» переключало бы вывод на другой
   * формат посреди периода.
   */
  private buildEachMoreKeyboard(days: number, offset: number, remaining: number): InlineKeyboardMarkup | undefined {
    return this.buildContinueKeyboard(buildSearchExpandCallbackData(days, offset), days, offset, remaining);
  }

  private buildContinueKeyboard(
    callbackData: string | null,
    days: number,
    offset: number,
    remaining: number,
  ): InlineKeyboardMarkup | undefined {
    if (!callbackData) {
      this.logger.error(
        `callback_data для кнопки "Показать ещё" превысил 64 байта (days=${days}, offset=${offset}) — кнопка не показана`,
      );
      return undefined;
    }
    return Markup.inlineKeyboard([Markup.button.callback(`Показать ещё (осталось ${remaining})`, callbackData)]).reply_markup;
  }

  /**
   * Перезаписывает дашборд и ленту веб-интерфейса выдачей за этот период.
   *
   * Ошибка здесь НЕ срывает ответ в Telegram: база может быть недоступна (на стенде её может не
   * быть поднято вовсе), а /search обязан отвечать и без неё — это вся причина, по которой он
   * читает карточки из JSON. Поэтому сбой логируется и уезжает в сообщение отдельной строкой
   * (published: null), чтобы человек не искал в веб-интерфейсе то, чего туда не попало.
   */
  private async publishToDashboard(
    days: number,
    now: Date,
    live: CuratedMentionView[] = [],
  ): Promise<DashboardPublishNote> {
    try {
      const outcome = await this.dashboardPublishService.publish(days, now, live);
      return { published: outcome.published };
    } catch (error) {
      this.logger.error(`Не удалось перенести выдачу /search в дашборд: ${describeError(error)}`);
      return { published: null };
    }
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

/**
 * Найденное живым поиском в том же виде, в каком выдача показывает любой другой материал. `null`
 * (поиск упал целиком) — это пустой вклад, а не ошибка: выдача уходит человеку как обычно.
 */
function liveItems(outcome: LiveSearchOutcome | null): CuratedMentionView[] {
  return (outcome?.finds ?? []).map(liveFindToMentionView);
}

/** Новые сверху. Материал без даты уходит в конец: сравнивать его по дате нечем. */
function byPublishedAtDesc(a: CuratedMentionView, b: CuratedMentionView): number {
  const left = a.publishedAt ? a.publishedAt.getTime() : -Infinity;
  const right = b.publishedAt ? b.publishedAt.getTime() : -Infinity;
  return right - left;
}

/**
 * Итоги по списку, который реально уедет в сообщение, — вместе с найденным живым поиском.
 *
 * Пересчитывать приходится потому, что `search()` знает только про свою часть: если взять его
 * `total` и его разбивку по тональности, шапка сказала бы «Всего: 5» над списком из семи строк.
 */
function withMergedTotals(result: CuratedSearchResult, merged: CuratedMentionView[]): CuratedSearchResult {
  const bySentiment: Record<Sentiment, number> = {
    [Sentiment.POSITIVE]: 0,
    [Sentiment.NEGATIVE]: 0,
    [Sentiment.NEUTRAL]: 0,
    [Sentiment.UNDEFINED]: 0,
  };
  for (const item of merged) {
    bySentiment[item.sentiment] += 1;
  }
  return { ...result, total: merged.length, bySentiment };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}
