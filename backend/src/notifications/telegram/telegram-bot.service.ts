import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Context, Markup, Telegraf } from 'telegraf';
import { Update } from 'telegraf/types';
import { SettingsService } from '../../settings/settings.service';
import { SourcesService } from '../../sources/sources.service';
import { SourceStatus } from '../../sources/source.entity';
import { OnDemandSearchService, OnDemandSearchSummary } from '../../search-on-demand/on-demand-search.service';
import { formatSentiment } from '../../sentiment/sentiment-display.util';

interface ChannelStatus {
  lastSuccessAt: Date | null;
  active: number;
  error: number;
}

/** One button in the /search period picker. */
interface SearchPeriodOption {
  days: number;
  label: string;
}

// Capped at "Месяц" (30 дней): the backend runs on Vercel's Hobby plan, which hard-caps every
// function invocation at 60s regardless of vercel.json's maxDuration — a longer period (Полгода/
// Год) sequentially queries every source plus a per-new-item OpenAI sentiment call and reliably
// blows past that limit, silently killing the request with no reply at all (confirmed live: a
// "Год" search left the chat with no response for 10+ minutes). Raise this back once the project
// is on a plan where maxDuration=300 in vercel.json actually applies.
const SEARCH_PERIOD_OPTIONS: SearchPeriodOption[] = [
  { days: 1, label: 'Сутки' },
  { days: 3, label: '3 дня' },
  { days: 7, label: 'Неделя' },
  { days: 14, label: 'Две недели' },
  { days: 30, label: 'Месяц' },
];

const SEARCH_MESSAGE_CHAR_LIMIT = 3500;
const SEARCH_MAX_ITEMS_SHOWN = 200;

/**
 * Owns the single Telegraf bot instance for the whole app — both inbound commands (/status,
 * /search, dispatched via handleUpdate() from TelegramWebhookController) and outbound alerts
 * (via getBot(), used by TelegramNotifierService) share it.
 *
 * Webhook, not long-poll: a Vercel Function instance is frozen/torn down between requests
 * (scale-to-zero after ~5 min idle, ~30s on preview deployments) — nothing can keep a persistent
 * bot.launch()/getUpdates connection open across that. Telegram calls TelegramWebhookController's
 * POST /telegram/webhook once per update instead; this service just builds the Telegraf instance
 * and registers handlers, it never opens a connection of its own.
 */
@Injectable()
export class TelegramBotService implements OnModuleInit {
  private readonly logger = new Logger(TelegramBotService.name);
  private bot: Telegraf | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly settingsService: SettingsService,
    private readonly sourcesService: SourcesService,
    private readonly onDemandSearchService: OnDemandSearchService,
  ) {}

  /**
   * No bot.launch() here — see class-level comment. This just builds the Telegraf instance and
   * registers the command/action handlers so handleUpdate() (called by TelegramWebhookController)
   * has something to dispatch to; it runs on every cold start, which is fine since it does no
   * network calls of its own. Registering the webhook URL with Telegram is a separate, one-time
   * step (`npm run set-webhook`) — doing it here on every cold start would hit Telegram's API on
   * every request and race across concurrent instances for no benefit.
   */
  async onModuleInit(): Promise<void> {
    const token = this.config.get<string>('telegramBot.token');
    if (!token) {
      this.logger.warn('TELEGRAM_BOT_TOKEN не задан — команды /status, /search недоступны, отправка уведомлений тоже работать не будет.');
      return;
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
        { command: 'status', description: 'Текущий статус сбора' },
        { command: 'search', description: 'Разовый поиск упоминаний за период' },
      ]);
    } catch (error) {
      this.logger.warn(`Не удалось задать список команд бота (не критично): ${describeError(error)}`);
    }

    this.logger.log('Telegram-бот готов принимать вебхуки: /status, /search');
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
   * blocks the concrete threat named in the brief (a stranger DMing the bot). /search reuses the
   * exact same check as /status — every OpenAI web search call it can trigger is billed, so it
   * gets the same protection as the other admin-only command.
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
      const enabled = await this.settingsService.isCollectionEnabled();
      const byChannel = await this.summarizeChannels();

      const lines = [`Сбор упоминаний: ${enabled ? 'включён ✅' : 'на паузе ⏸'}`, '', 'Последний успешный цикл по каналам:'];
      for (const [type, info] of byChannel) {
        const last = info.lastSuccessAt
          ? info.lastSuccessAt.toLocaleString('ru-RU', { timeZone: 'Asia/Almaty' })
          : 'ещё ни разу';
        lines.push(`• ${type}: ${last} (активных: ${info.active}, с ошибкой: ${info.error})`);
      }

      await ctx.reply(lines.join('\n'));
    });

    // /search: a one-off, on-demand search over a user-chosen period. It's the only way mentions
    // get collected any more (see README "Деплой на Vercel" — background scheduled collection was
    // removed entirely for the Vercel deploy).
    bot.command('search', async (ctx) => {
      if (!this.isAuthorizedChat(ctx.chat?.id)) {
        await this.rejectUnauthorized(ctx);
        return;
      }
      const rows = chunkArray(SEARCH_PERIOD_OPTIONS, 3).map((row) =>
        row.map((option) => Markup.button.callback(option.label, `search_period:${option.days}`)),
      );
      const socialSearchEnabled = this.config.get<boolean>('openaiSocialSearch.enabled') ?? false;
      const webSearchNote = socialSearchEnabled
        ? 'и по объединённому веб-поиску (соцсети/форумы/блоги через OpenAI).\n\n' +
          '⚠ Поиск за длительный период (полгода, год) может занять больше времени — но не дороже: ' +
          'вызов веб-поиска OpenAI всегда один, независимо от периода.'
        : '(поиск по всему интернету через OpenAI — канал К-6 — временно приостановлен, ' +
          'SOCIAL_SEARCH_ENABLED=false).';
      await ctx.reply(
        'За какой период искать упоминания?\n\n' +
          'Разовый поиск проходит сразу по всем подключённым источникам (сайты, Telegram-каналы, VK, NewsAPI) ' +
          webSearchNote,
        Markup.inlineKeyboard(rows),
      );
    });

    bot.action(/^search_period:(\d+)$/, async (ctx) => {
      if (!this.isAuthorizedChat(ctx.chat?.id)) {
        await ctx.answerCbQuery('Эта команда доступна только в рабочей группе мониторинга.');
        return;
      }

      const days = parseInt((ctx.match as RegExpMatchArray)[1], 10);
      const option = SEARCH_PERIOD_OPTIONS.find((o) => o.days === days);
      const label = option?.label ?? `${days} дн.`;

      await ctx.answerCbQuery();
      await ctx.editMessageText(`Ищу за последние ${days} дней (${label})...`);
      this.logger.log(
        `/search запущен: период=${days} дн. (chat_id=${ctx.chat?.id}, user=${ctx.from?.username ?? ctx.from?.id})`,
      );

      const chatId = ctx.chat?.id;
      if (chatId === undefined) {
        return;
      }

      // Awaited before responding to the webhook request. Previously this ran via waitUntil()
      // (@vercel/functions) as fire-and-forget, relying on the platform to keep the instance alive
      // past the webhook response — but this deploy runs the backend as a Vercel "Container"
      // function, which spins up a fresh process per request (see the full Nest bootstrap log on
      // every single call) and tears it down right after the response is sent, regardless of
      // waitUntil(). That killed the DB connection mid-search (TypeORM "Driver not Connected")
      // before the background work could finish. Awaiting here keeps the process alive for the
      // whole search — bounded by vercel.json's maxDuration (300s), same ceiling the old approach
      // relied on anyway.
      await this.runOnDemandSearchAndReport(ctx.telegram, chatId, days, label);
    });
  }

  private async runOnDemandSearchAndReport(
    telegram: Telegraf['telegram'],
    chatId: number,
    days: number,
    label: string,
  ): Promise<void> {
    try {
      const summary = await this.onDemandSearchService.runSearch(days);
      const messages = this.buildSearchSummaryMessages(days, label, summary);
      for (const message of messages) {
        await telegram.sendMessage(chatId, message, {
          parse_mode: 'HTML',
          link_preview_options: { is_disabled: true },
        });
      }
    } catch (error) {
      const reason = describeError(error);
      this.logger.error(`/search (период=${days} дн.) завершился ошибкой: ${reason}`);
      await telegram.sendMessage(chatId, `Не удалось выполнить поиск за последние ${days} дней: ${reason}`);
    }
  }

  private buildSearchSummaryMessages(days: number, periodLabel: string, summary: OnDemandSearchSummary): string[] {
    const failedNote = summary.sourcesFailed.length
      ? `\n⚠ Не удалось опросить: ${summary.sourcesFailed.map((f) => escapeHtml(f.label)).join(', ')}.`
      : '';
    const costNote = `Вызовов инструмента веб-поиска OpenAI использовано в этом запросе: ${summary.openAiWebSearchCalls}.`;

    if (summary.totalMatched === 0) {
      return [`За последние ${days} дней (${periodLabel}) новых упоминаний не найдено.${failedNote}\n\n${costNote}`];
    }

    const header =
      `<b>Результаты поиска за ${periodLabel}</b>\n` +
      `Всего найдено: ${summary.totalMatched} (новых: ${summary.newCount}, уже было известно: ${summary.knownCount})\n` +
      `${costNote}${failedNote}`;

    const shown = summary.items.slice(0, SEARCH_MAX_ITEMS_SHOWN);
    const omitted = summary.items.length - shown.length;

    const blocks = shown.map((item, index) => {
      const published = item.publishedAt
        ? item.publishedAt.toLocaleString('ru-RU', { timeZone: 'Asia/Almaty' })
        : 'дата не определена';
      const knownTag = item.status === 'known' ? ' (уже было известно ранее)' : '';
      return (
        `${index + 1}. ${formatSentiment(item.sentiment)} · ${escapeHtml(item.title)}${knownTag}\n` +
        `Источник: ${escapeHtml(item.sourceLabel)}\n` +
        `Дата: ${published}\n` +
        item.url
      );
    });

    if (omitted > 0) {
      blocks.push(
        `… и ещё ${omitted} находок. Выгрузки файлом пока нет — показаны первые ${SEARCH_MAX_ITEMS_SHOWN}.`,
      );
    }

    const messages: string[] = [];
    let current = header;
    for (const block of blocks) {
      if (current.length + block.length + 2 > SEARCH_MESSAGE_CHAR_LIMIT) {
        messages.push(current);
        current = block;
      } else {
        current += '\n\n' + block;
      }
    }
    messages.push(current);
    return messages;
  }

  private async rejectUnauthorized(ctx: Context): Promise<void> {
    this.logger.warn(`Отклонена команда из неавторизованного чата (chat_id=${ctx.chat?.id})`);
    await ctx.reply('Эта команда доступна только в рабочей группе мониторинга.');
  }

  private async summarizeChannels(): Promise<Map<string, ChannelStatus>> {
    const sources = await this.sourcesService.findAll();
    const byType = new Map<string, ChannelStatus>();

    for (const source of sources) {
      if (source.status === SourceStatus.DISABLED) {
        continue;
      }
      const entry = byType.get(source.type) ?? { lastSuccessAt: null, active: 0, error: 0 };
      if (source.status === SourceStatus.ACTIVE) {
        entry.active += 1;
      } else if (source.status === SourceStatus.ERROR) {
        entry.error += 1;
      }
      if (source.lastSuccessAt && (!entry.lastSuccessAt || source.lastSuccessAt > entry.lastSuccessAt)) {
        entry.lastSuccessAt = source.lastSuccessAt;
      }
      byType.set(source.type, entry);
    }

    return byType;
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function escapeHtml(input: string): string {
  return input.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}