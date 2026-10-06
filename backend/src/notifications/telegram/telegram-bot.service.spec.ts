import { ConfigService } from '@nestjs/config';
import { TelegramBotService } from './telegram-bot.service';
import { CuratedSearchService, CuratedSearchResult, CuratedMentionView, PoolStats } from '../../curated/curated-search.service';
import { CuratedResetService } from '../../curated/curated-reset.service';
import { CuratedLinkStatus } from '../../curated/curated-link.entity';
import { CuratedMentionsService } from '../../curated/curated-mentions.service';
import { Sentiment } from '../../mentions/mention.entity';
import { DEFAULT_SEARCH_PERIOD_DAYS } from '../../curated/search-period.util';

type CommandHandler = (ctx: any) => Promise<void>;
type ActionHandler = (ctx: any) => Promise<void>;

const commandHandlers = new Map<string, CommandHandler>();
const actionHandlers = new Map<string, ActionHandler>();
const handleUpdateMock = jest.fn(async () => undefined);
const setMyCommandsMock = jest.fn(async () => undefined);
const sendMessageMock = jest.fn(async (..._args: unknown[]) => undefined);
const catchMock = jest.fn();
const stopMock = jest.fn();
// launch() resolves only when the bot stops — the mock mirrors that (a never-settling promise),
// so a test would hang if the service ever awaited it instead of the onLaunch callback.
const launchMock = jest.fn(
  (_config: unknown, onLaunch?: () => void) =>
    new Promise<void>(() => {
      onLaunch?.();
    }),
);

jest.mock('telegraf', () => {
  const actual = jest.requireActual('telegraf');
  return {
    ...actual,
    Telegraf: jest.fn().mockImplementation(() => ({
      command: (name: string, handler: CommandHandler) => commandHandlers.set(name, handler),
      action: (pattern: RegExp, handler: ActionHandler) => actionHandlers.set(pattern.toString(), handler),
      handleUpdate: handleUpdateMock,
      catch: catchMock,
      launch: launchMock,
      stop: stopMock,
      telegram: { setMyCommands: setMyCommandsMock, sendMessage: sendMessageMock },
    })),
  };
});

function makeConfig(
  chatId = '-1001',
  mode: 'polling' | 'webhook' = 'webhook',
  extra: Record<string, unknown> = {},
): ConfigService {
  const values: Record<string, unknown> = {
    'telegramBot.token': 'tok',
    'telegramBot.chatId': chatId,
    'telegramBot.mode': mode,
    'curated.periodDays': [...DEFAULT_SEARCH_PERIOD_DAYS],
    'curated.timezone': 'Asia/Almaty',
    'curated.messageCharLimit': 3500,
    ...extra,
  };
  return { get: jest.fn((key: string) => values[key]) } as unknown as ConfigService;
}

function makeCtx(chatId: number | string | undefined, overrides: Record<string, unknown> = {}) {
  return {
    chat: chatId === undefined ? undefined : { id: chatId },
    from: { id: 42, username: 'admin' },
    reply: jest.fn(async () => undefined),
    answerCbQuery: jest.fn(async () => undefined),
    editMessageText: jest.fn(async () => undefined),
    editMessageReplyMarkup: jest.fn(async () => undefined),
    telegram: { sendMessage: sendMessageMock },
    match: ['search_period:7', '7'],
    ...overrides,
  };
}

function makePoolStats(overrides: Partial<PoolStats> = {}): PoolStats {
  return {
    totalLinks: 169,
    byStatus: {
      [CuratedLinkStatus.PENDING]: 0,
      [CuratedLinkStatus.PROCESSED]: 169,
      [CuratedLinkStatus.NOT_RELEVANT]: 0,
      [CuratedLinkStatus.FAILED]: 0,
      [CuratedLinkStatus.EXCLUDED]: 0,
    },
    mentionsTotal: 169,
    undatedMentions: 0,
    firstArticleDate: new Date('2020-01-10T00:00:00Z'),
    lastArticleDate: new Date('2026-09-15T00:00:00Z'),
    lastProcessedAt: new Date('2026-09-16T08:00:00Z'),
    ...overrides,
  };
}

function makeSearchResult(overrides: Partial<CuratedSearchResult> = {}): CuratedSearchResult {
  return {
    periodDays: 7,
    dateFrom: '2026-09-09',
    dateTo: '2026-09-16',
    total: 0,
    bySentiment: {
      [Sentiment.POSITIVE]: 0,
      [Sentiment.NEGATIVE]: 0,
      [Sentiment.NEUTRAL]: 0,
      [Sentiment.UNDEFINED]: 0,
    },
    undatedCount: 0,
    processedNow: 0,
    pool: makePoolStats(),
    ...overrides,
  };
}

function makeMentionView(overrides: Partial<CuratedMentionView> = {}): CuratedMentionView {
  return {
    id: 'm-1',
    title: 'QazCloud упомянут в статье',
    sourceLabel: 'Подборка материалов',
    publishedAt: new Date('2026-09-14T10:00:00Z'),
    sentiment: Sentiment.POSITIVE,
    summary: 'Короткий пересказ статьи.',
    snippet: null,
    ...overrides,
  };
}

function makeCuratedResetService(preview = { links: 169, mentions: 167 }): CuratedResetService {
  return {
    preview: jest.fn(async () => preview),
    reset: jest.fn(async () => ({ ...preview, mentionsDeleted: preview.mentions })),
  } as unknown as CuratedResetService;
}

function makeCuratedSearchService(config: {
  pool?: Partial<PoolStats>;
  searchResult?: Partial<CuratedSearchResult>;
  page?: CuratedMentionView[];
} = {}): CuratedSearchService {
  const pool = makePoolStats(config.pool);
  return {
    getPoolStats: jest.fn(async () => pool),
    search: jest.fn(async (periodDays: number) => makeSearchResult({ periodDays, pool, ...config.searchResult })),
    findPage: jest.fn(async () => config.page ?? []),
  } as unknown as CuratedSearchService;
}

describe('TelegramBotService (closed-pool bot)', () => {
  beforeEach(() => {
    commandHandlers.clear();
    actionHandlers.clear();
    handleUpdateMock.mockClear();
    setMyCommandsMock.mockClear();
    sendMessageMock.mockClear();
    catchMock.mockClear();
    launchMock.mockClear();
    stopMock.mockClear();
  });

  async function boot(
    chatId = '-1001',
    curatedSearchService: CuratedSearchService = makeCuratedSearchService(),
    mode: 'polling' | 'webhook' = 'webhook',
    curatedResetService: CuratedResetService = makeCuratedResetService(),
    extraConfig: Record<string, unknown> = {},
  ): Promise<{
    service: TelegramBotService;
    curatedSearchService: CuratedSearchService;
    curatedResetService: CuratedResetService;
  }> {
    const service = new TelegramBotService(
      makeConfig(chatId, mode, extraConfig),
      curatedSearchService,
      curatedResetService,
      new CuratedMentionsService(),
    );
    await service.onModuleInit();
    return { service, curatedSearchService, curatedResetService };
  }

  it('registers /status and /search on init, without starting a long-poll connection in webhook mode', async () => {
    await boot();
    expect(launchMock).not.toHaveBeenCalled();
    expect(commandHandlers.has('status')).toBe(true);
    expect(commandHandlers.has('search')).toBe(true);
    expect(commandHandlers.has('pause')).toBe(false);
    expect(commandHandlers.has('resume')).toBe(false);
    expect(setMyCommandsMock).toHaveBeenCalled();
    expect(catchMock).toHaveBeenCalled();
  });

  it('dispatches an incoming webhook update to the underlying Telegraf instance', async () => {
    const { service } = await boot();
    const update = { update_id: 1, message: { chat: { id: -1001 }, text: '/status' } } as any;

    await service.handleUpdate(update);

    expect(handleUpdateMock).toHaveBeenCalledWith(update);
  });

  it('throws from handleUpdate when TELEGRAM_BOT_TOKEN was never configured', async () => {
    const config = { get: jest.fn(() => '') } as unknown as ConfigService;
    const service = new TelegramBotService(
      config,
      makeCuratedSearchService(),
      makeCuratedResetService(),
      new CuratedMentionsService(),
    );
    await service.onModuleInit();

    await expect(service.handleUpdate({} as any)).rejects.toThrow('TELEGRAM_BOT_TOKEN');
  });

  describe('режим получения апдейтов', () => {
    // The local docker compose stand cannot be reached by Telegram at all, so a webhook-only bot
    // answers nothing there — polling mode is what makes /status and /search work on localhost.
    it('opens the long-poll loop in polling mode and still registers the same commands', async () => {
      await boot('-1001', makeCuratedSearchService(), 'polling');

      expect(launchMock).toHaveBeenCalledTimes(1);
      expect(launchMock.mock.calls[0][0]).toEqual({ dropPendingUpdates: true });
      expect(commandHandlers.has('status')).toBe(true);
      expect(commandHandlers.has('search')).toBe(true);
    });

    it('does not hang bootstrap even though launch() never resolves', async () => {
      // onModuleInit must return once polling has started; if it awaited launch() itself, Nest
      // would never finish booting and the HTTP server would never listen.
      await expect(boot('-1001', makeCuratedSearchService(), 'polling')).resolves.toBeDefined();
    });

    it('keeps the rest of the stand up when long polling fails to start', async () => {
      launchMock.mockImplementationOnce(() => Promise.reject(new Error('401: Unauthorized')));

      await expect(boot('-1001', makeCuratedSearchService(), 'polling')).resolves.toBeDefined();
    });

    it('stops the long-poll loop on shutdown, and only when it was actually started', async () => {
      const { service } = await boot('-1001', makeCuratedSearchService(), 'polling');
      await service.onModuleDestroy();
      expect(stopMock).toHaveBeenCalledTimes(1);

      const webhookBoot = await boot('-1001', makeCuratedSearchService(), 'webhook');
      await webhookBoot.service.onModuleDestroy();
      expect(stopMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('/reset (сброс пула)', () => {
    // The whole point of the two-step flow: /reset is a question, never an action. Anything that
    // deletes 167 mentions must not fire from a single command that could be typed by accident.
    it('only previews on /reset — nothing is reset until the confirm button is pressed', async () => {
      const curatedResetService = makeCuratedResetService();
      await boot('-1001', makeCuratedSearchService(), 'webhook', curatedResetService);
      const ctx = makeCtx('-1001');

      await commandHandlers.get('reset')!(ctx);

      expect(curatedResetService.preview).toHaveBeenCalled();
      expect(curatedResetService.reset).not.toHaveBeenCalled();
      const [text] = (ctx.reply as jest.Mock).mock.calls[0];
      expect(text).toContain('Сбросить пул ссылок?');
      expect(text).toContain('169');
      expect(text).toContain('167');
      // The irreversible parts have to be stated on the button itself, not just in the README.
      expect(text).toContain('необратимо');
      expect(text).toContain('ручные правки');
    });

    it('resets only after the confirm button, and reports what was deleted', async () => {
      const curatedResetService = makeCuratedResetService();
      await boot('-1001', makeCuratedSearchService(), 'webhook', curatedResetService);
      const ctx = makeCtx('-1001');

      await actionHandlers.get('pool_reset:confirm')!(ctx);

      expect(curatedResetService.reset).toHaveBeenCalled();
      expect(ctx.editMessageText).toHaveBeenCalledWith(expect.stringContaining('Удалено упоминаний: 167'));
    });

    it('cancel button changes nothing', async () => {
      const curatedResetService = makeCuratedResetService();
      await boot('-1001', makeCuratedSearchService(), 'webhook', curatedResetService);
      const ctx = makeCtx('-1001');

      await actionHandlers.get('pool_reset:cancel')!(ctx);

      expect(curatedResetService.reset).not.toHaveBeenCalled();
      expect(ctx.editMessageText).toHaveBeenCalledWith(expect.stringContaining('отменён'));
    });

    it('refuses /reset and the confirm button from a chat that is not the configured group', async () => {
      const curatedResetService = makeCuratedResetService();
      await boot('-1001', makeCuratedSearchService(), 'webhook', curatedResetService);

      const strangerCommand = makeCtx(999999);
      await commandHandlers.get('reset')!(strangerCommand);
      expect(curatedResetService.preview).not.toHaveBeenCalled();

      // Guarded separately from the command: a confirm callback can arrive on its own, from a
      // forwarded/copied message, without /reset ever being typed in that chat.
      const strangerConfirm = makeCtx(999999);
      await actionHandlers.get('pool_reset:confirm')!(strangerConfirm);
      expect(curatedResetService.reset).not.toHaveBeenCalled();
    });

    it('says there is nothing to reset instead of offering a button for an empty pool', async () => {
      const curatedResetService = makeCuratedResetService({ links: 0, mentions: 0 });
      await boot('-1001', makeCuratedSearchService(), 'webhook', curatedResetService);
      const ctx = makeCtx('-1001');

      await commandHandlers.get('reset')!(ctx);

      expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('сбрасывать нечего'));
      expect(curatedResetService.reset).not.toHaveBeenCalled();
    });

    it('reports a failed reset instead of leaving the confirmation hanging', async () => {
      const curatedResetService = makeCuratedResetService();
      (curatedResetService.reset as jest.Mock).mockRejectedValueOnce(new Error('connection terminated'));
      await boot('-1001', makeCuratedSearchService(), 'webhook', curatedResetService);
      const ctx = makeCtx('-1001');

      await actionHandlers.get('pool_reset:confirm')!(ctx);

      expect(ctx.editMessageText).toHaveBeenCalledWith(expect.stringContaining('Не удалось сбросить пул'));
    });
  });

  describe('/status', () => {
    it('reports pool statistics with no URLs and no per-channel breakdown', async () => {
      const curatedSearchService = makeCuratedSearchService({
        pool: {
          totalLinks: 169,
          byStatus: {
            [CuratedLinkStatus.PENDING]: 3,
            [CuratedLinkStatus.PROCESSED]: 160,
            [CuratedLinkStatus.NOT_RELEVANT]: 5,
            [CuratedLinkStatus.FAILED]: 1,
            [CuratedLinkStatus.EXCLUDED]: 0,
          },
          mentionsTotal: 160,
          undatedMentions: 2,
        },
      });
      await boot('-1001', curatedSearchService);
      const ctx = makeCtx('-1001');

      await commandHandlers.get('status')!(ctx);

      expect(curatedSearchService.getPoolStats).toHaveBeenCalled();
      const replied = (ctx.reply as jest.Mock).mock.calls[0]?.[0] as string;
      expect(replied).toContain('169 всего');
      expect(replied).toContain('обработано 160');
      expect(replied).toContain('не релевантны 5');
      expect(replied).toContain('с ошибкой 1');
      expect(replied).toContain('в очереди 3');
      expect(replied).toContain('Без даты: 2');
      expect(replied).not.toMatch(/https?:\/\//);
    });

    it('rejects /status from a chat that is not the configured group (e.g. a DM to the bot)', async () => {
      const { curatedSearchService } = await boot('-1001');
      const dmCtx = makeCtx('999999');

      await commandHandlers.get('status')!(dmCtx);

      expect(curatedSearchService.getPoolStats).not.toHaveBeenCalled();
      expect(dmCtx.reply).toHaveBeenCalledWith('Эта команда доступна только в рабочей группе мониторинга.');
    });

    it('rejects commands when chat is entirely missing from the update', async () => {
      await boot('-1001');
      const ctx = makeCtx(undefined);

      await commandHandlers.get('status')!(ctx);

      expect(ctx.reply).toHaveBeenCalledWith('Эта команда доступна только в рабочей группе мониторинга.');
    });
  });

  describe('/search command (period picker)', () => {
    it('shows one button per configured SEARCH_PERIOD_DAYS entry', async () => {
      await boot('-1001');
      const ctx = makeCtx('-1001');

      await commandHandlers.get('search')!(ctx);

      expect(ctx.reply).toHaveBeenCalledWith(
        'За какой период показать упоминания из пула ссылок?',
        expect.anything(),
      );
      const [, extra] = (ctx.reply as jest.Mock).mock.calls[0];
      const buttons = extra.reply_markup.inline_keyboard.flat();
      expect(buttons).toHaveLength(DEFAULT_SEARCH_PERIOD_DAYS.length);
      expect(buttons.map((b: any) => b.callback_data)).toEqual(
        expect.arrayContaining(['search_period:1', 'search_period:730']),
      );
      expect(buttons.map((b: any) => b.text)).toEqual(expect.arrayContaining(['Сутки', '2 года']));
    });

    it('rejects /search from a chat that is not the configured group', async () => {
      await boot('-1001');
      const dmCtx = makeCtx('999999');

      await commandHandlers.get('search')!(dmCtx);

      expect(dmCtx.reply).toHaveBeenCalledWith('Эта команда доступна только в рабочей группе мониторинга.');
    });
  });

  describe('search_period callback', () => {
    it('rejects the callback from an unauthorized chat without ever touching the curated pool', async () => {
      const { curatedSearchService } = await boot('-1001');
      const ctx = makeCtx('999999');

      await actionHandlers.get('/^search_period:(\\d+)$/')!(ctx);

      expect(curatedSearchService.search).not.toHaveBeenCalled();
      expect(ctx.answerCbQuery).toHaveBeenCalledWith('Эта команда доступна только в рабочей группе мониторинга.');
    });

    it('answers "Неизвестный период" for a days value outside SEARCH_PERIOD_DAYS, without searching', async () => {
      const { curatedSearchService } = await boot('-1001');
      const ctx = makeCtx('-1001', { match: ['search_period:999999', '999999'] });

      await actionHandlers.get('/^search_period:(\\d+)$/')!(ctx);

      expect(ctx.answerCbQuery).toHaveBeenCalledWith('Неизвестный период');
      expect(curatedSearchService.search).not.toHaveBeenCalled();
    });

    it('never calls any collector service — /search only ever touches CuratedSearchService', async () => {
      const curatedSearchService = makeCuratedSearchService();
      await boot('-1001', curatedSearchService);
      const ctx = makeCtx('-1001');

      await actionHandlers.get('/^search_period:(\\d+)$/')!(ctx);

      // The mock constructor takes no collector dependencies at all — this test's real assertion
      // is structural (see the constructor signature in telegram-bot.service.ts): TelegramBotService
      // no longer has a way to reach RSS/Parser/Telegram/NewsAPI/VK/OpenAI web search from /search.
      expect(curatedSearchService.search).toHaveBeenCalledWith(7, expect.any(Date));
    });

    // The CURATED_LAZY_PROCESS pass inside search() downloads pool pages and classifies tone via
    // OpenAI before reading, so the button press is followed by real seconds of work. The status
    // line has to go out BEFORE that call, or the chat sits blank and looks broken.
    it('posts the "ищу упоминания" status before search() starts, not after it returns', async () => {
      const order: string[] = [];
      const curatedSearchService = makeCuratedSearchService();
      (curatedSearchService.search as jest.Mock).mockImplementation(async (periodDays: number) => {
        order.push('search');
        return makeSearchResult({ periodDays });
      });
      await boot('-1001', curatedSearchService);
      const ctx = makeCtx('-1001');
      ctx.editMessageText = jest.fn(async (...args: unknown[]) => {
        order.push(String(args[0]).startsWith('Ищу упоминания') ? 'status' : 'result');
        return undefined;
      }) as unknown as typeof ctx.editMessageText;

      await actionHandlers.get('/^search_period:(\\d+)$/')!(ctx);

      expect(order).toEqual(['status', 'search', 'result']);
    });

    it('reports how many links this call actually processed, and stays silent about it when none were', async () => {
      const withWork = makeCuratedSearchService({ searchResult: { processedNow: 4 } });
      await boot('-1001', withWork);
      const ctx = makeCtx('-1001');
      await actionHandlers.get('/^search_period:(\\d+)$/')!(ctx);
      expect(ctx.editMessageText).toHaveBeenCalledWith(expect.stringContaining('Обработано источников в этом запросе: 4'));

      const withoutWork = makeCuratedSearchService({ searchResult: { processedNow: 0 } });
      await boot('-1001', withoutWork);
      const ctx2 = makeCtx('-1001');
      await actionHandlers.get('/^search_period:(\\d+)$/')!(ctx2);
      expect(ctx2.editMessageText).not.toHaveBeenCalledWith(expect.stringContaining('Обработано источников'));
    });

    it('still runs the search when the status edit fails (an old message can no longer be edited)', async () => {
      const curatedSearchService = makeCuratedSearchService();
      await boot('-1001', curatedSearchService);
      const ctx = makeCtx('-1001');
      ctx.editMessageText = jest
        .fn()
        .mockRejectedValueOnce(new Error('message is not modified'))
        .mockResolvedValue(undefined) as unknown as typeof ctx.editMessageText;

      await actionHandlers.get('/^search_period:(\\d+)$/')!(ctx);

      expect(curatedSearchService.search).toHaveBeenCalled();
      expect(sendMessageMock).toHaveBeenCalled();
    });

    it('answers, edits the prompt message with the resolved date window, then sends the header + first page', async () => {
      const curatedSearchService = makeCuratedSearchService({
        searchResult: {
          total: 1,
          bySentiment: {
            [Sentiment.POSITIVE]: 1,
            [Sentiment.NEGATIVE]: 0,
            [Sentiment.NEUTRAL]: 0,
            [Sentiment.UNDEFINED]: 0,
          },
        },
        page: [makeMentionView({ title: 'QazCloud упомянут на форуме', sentiment: Sentiment.POSITIVE })],
      });
      await boot('-1001', curatedSearchService);
      const ctx = makeCtx('-1001');

      await actionHandlers.get('/^search_period:(\\d+)$/')!(ctx);

      expect(ctx.answerCbQuery).toHaveBeenCalled();
      expect(ctx.editMessageText).toHaveBeenCalledWith(expect.stringContaining('Период: Неделя'));
      expect(ctx.editMessageText).toHaveBeenCalledWith(expect.stringContaining('09.09.2026'));
      expect(sendMessageMock).toHaveBeenCalled();
      const [, message, extra] = sendMessageMock.mock.calls[0] as [unknown, string, any];
      expect(message).toContain('Упоминания за Неделя');
      expect(message).toContain('Всего: 1');
      expect(message).toContain('🟢 1');
      expect(message).toContain('QazCloud упомянут на форуме');
      expect(extra.parse_mode).toBe('HTML');
      expect(message).not.toMatch(/https?:\/\//);
    });

    it('reports the empty-pool text when the pool has no processed mentions at all', async () => {
      const curatedSearchService = makeCuratedSearchService({
        pool: { totalLinks: 0, mentionsTotal: 0, byStatus: { [CuratedLinkStatus.PENDING]: 0, [CuratedLinkStatus.PROCESSED]: 0, [CuratedLinkStatus.NOT_RELEVANT]: 0, [CuratedLinkStatus.FAILED]: 0, [CuratedLinkStatus.EXCLUDED]: 0 }, firstArticleDate: null, lastArticleDate: null, lastProcessedAt: null },
        searchResult: { total: 0 },
      });
      await boot('-1001', curatedSearchService);
      const ctx = makeCtx('-1001');

      await actionHandlers.get('/^search_period:(\\d+)$/')!(ctx);

      const [, message] = sendMessageMock.mock.calls[0];
      expect(message).toBe('Пул ссылок пуст или ещё не обработан.');
    });

    it('reports an explicit "nothing in this period" text (with processed count + freshest date) when the pool has data but this window is empty', async () => {
      const curatedSearchService = makeCuratedSearchService({
        pool: { byStatus: { [CuratedLinkStatus.PENDING]: 0, [CuratedLinkStatus.PROCESSED]: 169, [CuratedLinkStatus.NOT_RELEVANT]: 0, [CuratedLinkStatus.FAILED]: 0, [CuratedLinkStatus.EXCLUDED]: 0 }, lastArticleDate: new Date('2026-08-01T00:00:00Z') },
        searchResult: { total: 0 },
      });
      await boot('-1001', curatedSearchService);
      const ctx = makeCtx('-1001');

      await actionHandlers.get('/^search_period:(\\d+)$/')!(ctx);

      const [, message] = sendMessageMock.mock.calls[0];
      expect(message).toContain('упоминаний в пуле ссылок не найдено');
      expect(message).toContain('Обработано ссылок: 169');
      expect(message).toContain('01.08.2026');
      expect(message).not.toMatch(/https?:\/\//);
    });

    it('mentions the undated count and the pending/failed queue in the header when present', async () => {
      const curatedSearchService = makeCuratedSearchService({
        searchResult: {
          total: 1,
          undatedCount: 4,
          pool: makePoolStats({
            byStatus: {
              [CuratedLinkStatus.PENDING]: 2,
              [CuratedLinkStatus.PROCESSED]: 165,
              [CuratedLinkStatus.NOT_RELEVANT]: 0,
              [CuratedLinkStatus.FAILED]: 1,
              [CuratedLinkStatus.EXCLUDED]: 0,
            },
          }),
        },
        page: [makeMentionView()],
      });
      await boot('-1001', curatedSearchService);
      const ctx = makeCtx('-1001');

      await actionHandlers.get('/^search_period:(\\d+)$/')!(ctx);

      const [, message] = sendMessageMock.mock.calls[0];
      expect(message).toContain('Без даты публикации (в выборки по периоду не входят): 4');
      expect(message).toContain('В очереди на обработку: 2 · с ошибкой: 1');
    });

    it('shows the correct sentiment emoji for each item and a "Показать ещё" button when more remain', async () => {
      const items = Array.from({ length: 3 }, (_, i) =>
        makeMentionView({ id: `m-${i}`, title: `Находка ${i}`, sentiment: Sentiment.NEUTRAL }),
      );
      const curatedSearchService = makeCuratedSearchService({
        searchResult: { total: 50 }, // far more than the 3 items "fetched" below -> more remain
        page: items,
      });
      await boot('-1001', curatedSearchService);
      const ctx = makeCtx('-1001');

      await actionHandlers.get('/^search_period:(\\d+)$/')!(ctx);

      const [, message, extra] = sendMessageMock.mock.calls[0] as [unknown, string, any];
      expect(message).toContain('🟡 Нейтрал · Находка 0');
      const button = extra.reply_markup.inline_keyboard[0][0];
      expect(button.text).toContain('Показать ещё');
      expect(button.text).toContain('47'); // 50 total - 3 shown
      expect(button.callback_data).toBe('search_more:7:3');
    });

    it('does not throw and reports a clear error (no stack trace, no URL) when the DB read fails', async () => {
      const curatedSearchService = {
        getPoolStats: jest.fn(async () => makePoolStats()),
        search: jest.fn(async () => {
          throw new Error('connection terminated unexpectedly');
        }),
        findPage: jest.fn(async () => []),
      } as unknown as CuratedSearchService;
      await boot('-1001', curatedSearchService);
      const ctx = makeCtx('-1001');

      await actionHandlers.get('/^search_period:(\\d+)$/')!(ctx);

      const [, message] = sendMessageMock.mock.calls[0];
      expect(message).toContain('Не удалось выполнить поиск');
      expect(message).toContain('connection terminated unexpectedly');
      expect(message).not.toMatch(/at .+\(.+:\d+:\d+\)/); // no stack-trace-shaped line
    });

    it('waits for the search to finish before the handler resolves (no fire-and-forget, no waitUntil)', async () => {
      let resolveSearch!: (result: CuratedSearchResult) => void;
      const slowCuratedSearchService = {
        getPoolStats: jest.fn(async () => makePoolStats()),
        search: jest.fn(() => new Promise<CuratedSearchResult>((resolve) => (resolveSearch = resolve))),
        findPage: jest.fn(async () => []),
      } as unknown as CuratedSearchService;
      await boot('-1001', slowCuratedSearchService);
      const ctx = makeCtx('-1001');

      let handlerResolved = false;
      const handlerPromise = actionHandlers.get('/^search_period:(\\d+)$/')!(ctx).then(() => {
        handlerResolved = true;
      });
      await new Promise((resolve) => setImmediate(resolve));

      expect(ctx.answerCbQuery).toHaveBeenCalled();
      expect(handlerResolved).toBe(false);
      expect(sendMessageMock).not.toHaveBeenCalled();

      resolveSearch(makeSearchResult({ total: 0 }));
      await handlerPromise;

      expect(handlerResolved).toBe(true);
      expect(sendMessageMock).toHaveBeenCalled();
    });
  });

  describe('search_more callback (pagination)', () => {
    function makeMoreCtx(chatId: number | string | undefined, days: number, offset: number) {
      return makeCtx(chatId, { match: [`search_more:${days}:${offset}`, String(days), String(offset)] });
    }

    it('rejects the callback from an unauthorized chat', async () => {
      const { curatedSearchService } = await boot('-1001');
      const ctx = makeMoreCtx('999999', 7, 3);

      await actionHandlers.get('/^search_more:(\\d+):(\\d+)$/')!(ctx);

      expect(curatedSearchService.findPage).not.toHaveBeenCalled();
      expect(ctx.answerCbQuery).toHaveBeenCalledWith('Эта команда доступна только в рабочей группе мониторинга.');
    });

    it('answers "Некорректный запрос" for a days value outside SEARCH_PERIOD_DAYS', async () => {
      const { curatedSearchService } = await boot('-1001');
      const ctx = makeMoreCtx('-1001', 999999, 0);

      await actionHandlers.get('/^search_more:(\\d+):(\\d+)$/')!(ctx);

      expect(ctx.answerCbQuery).toHaveBeenCalledWith('Некорректный запрос');
      expect(curatedSearchService.findPage).not.toHaveBeenCalled();
    });

    it('clears the keyboard on the previous message, fetches the next page at the given offset, and reports the correct remaining count', async () => {
      const items = [makeMentionView({ id: 'm-4', title: 'Находка 4' })];
      const curatedSearchService = makeCuratedSearchService({
        searchResult: { total: 5 },
        page: items,
      });
      await boot('-1001', curatedSearchService);
      const ctx = makeMoreCtx('-1001', 7, 4);

      await actionHandlers.get('/^search_more:(\\d+):(\\d+)$/')!(ctx);

      expect(ctx.answerCbQuery).toHaveBeenCalled();
      expect(ctx.editMessageReplyMarkup).toHaveBeenCalledWith({ inline_keyboard: [] });
      expect(curatedSearchService.findPage).toHaveBeenCalledWith(7, 4, expect.any(Number), expect.any(Date));
      const [, message, extra] = sendMessageMock.mock.calls[0] as [unknown, string, any];
      expect(message).toContain('5. '); // startIndex = offset + 1
      expect(message).toContain('Находка 4');
      expect(extra.reply_markup).toBeUndefined(); // 4 (offset) + 1 (shown) = 5 = total -> nothing left
    });

    it('sends a "no more records" message instead of an empty Telegram message when the offset is already past the end', async () => {
      const curatedSearchService = makeCuratedSearchService({ searchResult: { total: 2 }, page: [] });
      await boot('-1001', curatedSearchService);
      const ctx = makeMoreCtx('-1001', 7, 2);

      await actionHandlers.get('/^search_more:(\\d+):(\\d+)$/')!(ctx);

      const [, message] = sendMessageMock.mock.calls[0];
      expect(message).toBe('Больше записей нет.');
    });
  });

  /**
   * SEARCH_ONE_ARTICLE_PER_MESSAGE=true — one message per finding instead of a packed page.
   *
   * Fake timers throughout: the handler pauses ~700 ms between messages (Telegram's ~20
   * messages/minute cap into a group), which is real waiting the tests should not sit through.
   * The pauses themselves are part of the design and tested below as "a full batch fits the
   * Vercel 60s ceiling", not quietly skipped.
   */
  describe('SEARCH_ONE_ARTICLE_PER_MESSAGE', () => {
    const ONE_PER_MESSAGE = { 'curated.oneArticlePerMessage': true, 'curated.itemsPerBatch': 8 };

    /** findPage() that honours offset/limit, so batching and offsets are exercised for real. */
    function makePagedSearchService(total: number): CuratedSearchService {
      const pool = makePoolStats();
      const all = Array.from({ length: total }, (_, i) => makeMentionView({ id: `m-${i}`, title: `Находка ${i}` }));
      return {
        getPoolStats: jest.fn(async () => pool),
        search: jest.fn(async (periodDays: number) => makeSearchResult({ periodDays, pool, total })),
        findPage: jest.fn(async (_days: number, offset: number, limit: number) => all.slice(offset, offset + limit)),
      } as unknown as CuratedSearchService;
    }

    /** Runs a handler under fake timers, advancing past every inter-message pause. */
    async function runHandler(handler: ActionHandler, ctx: any): Promise<void> {
      jest.useFakeTimers();
      try {
        const promise = handler(ctx);
        await jest.advanceTimersByTimeAsync(120000);
        await promise;
      } finally {
        jest.useRealTimers();
      }
    }

    const periodHandler = () => actionHandlers.get('/^search_period:(\\d+)$/')!;
    const moreHandler = () => actionHandlers.get('/^search_more:(\\d+):(\\d+)$/')!;

    function sentTexts(): string[] {
      return sendMessageMock.mock.calls.map((call) => call[1] as string);
    }

    it('sends the header first, then each finding as its own message', async () => {
      await boot('-1001', makePagedSearchService(3), 'webhook', makeCuratedResetService(), ONE_PER_MESSAGE);

      await runHandler(periodHandler(), makeCtx('-1001'));

      const texts = sentTexts();
      expect(texts).toHaveLength(4); // header + 3 findings
      expect(texts[0]).toContain('Упоминания за Неделя');
      expect(texts[0]).toContain('Всего: 3');
      expect(texts[0]).not.toContain('Находка');
      expect(texts[1]).toContain('1. ');
      expect(texts[1]).toContain('Находка 0');
      expect(texts[2]).toContain('2. ');
      expect(texts[3]).toContain('3. ');
    });

    it('stops at SEARCH_ITEMS_PER_BATCH and offers the rest behind the same search_more button', async () => {
      await boot('-1001', makePagedSearchService(19), 'webhook', makeCuratedResetService(), ONE_PER_MESSAGE);

      await runHandler(periodHandler(), makeCtx('-1001'));

      expect(sentTexts()).toHaveLength(9); // header + 8 findings
      // The button rides on the last finding of the batch; callback_data keeps its existing shape.
      const last = sendMessageMock.mock.calls[8] as [unknown, string, any];
      const button = last[2].reply_markup.inline_keyboard[0][0];
      expect(button.text).toBe('Показать ещё (осталось 11)');
      expect(button.callback_data).toBe('search_more:7:8');
      // ...and on none of the earlier ones.
      expect((sendMessageMock.mock.calls[7] as any)[2].reply_markup).toBeUndefined();
    });

    it('walks the whole period over several presses with no duplicate and no gap', async () => {
      const total = 19;
      const curatedSearchService = makePagedSearchService(total);
      await boot('-1001', curatedSearchService, 'webhook', makeCuratedResetService(), ONE_PER_MESSAGE);

      await runHandler(periodHandler(), makeCtx('-1001'));
      for (const offset of [8, 16]) {
        await runHandler(moreHandler(), makeCtx('-1001', { match: [`search_more:7:${offset}`, '7', String(offset)] }));
      }

      // Every finding, exactly once, in order — header excluded.
      const numbered = sentTexts()
        .filter((t) => /^\d+\. /.test(t))
        .map((t) => parseInt(t.split('.')[0], 10));
      expect(numbered).toEqual(Array.from({ length: total }, (_, i) => i + 1));
      expect(curatedSearchService.findPage).toHaveBeenCalledWith(7, 0, 8, expect.any(Date));
      expect(curatedSearchService.findPage).toHaveBeenCalledWith(7, 8, 8, expect.any(Date));
      expect(curatedSearchService.findPage).toHaveBeenCalledWith(7, 16, 8, expect.any(Date));
    });

    it('drops the "Показать ещё" button on the last batch', async () => {
      await boot('-1001', makePagedSearchService(10), 'webhook', makeCuratedResetService(), ONE_PER_MESSAGE);

      await runHandler(moreHandler(), makeCtx('-1001', { match: ['search_more:7:8', '7', '8'] }));

      const calls = sendMessageMock.mock.calls;
      expect(calls).toHaveLength(2); // findings 9 and 10
      expect((calls[1] as any)[2].reply_markup).toBeUndefined();
    });

    it('says "Больше записей нет." when the offset is already past the end', async () => {
      await boot('-1001', makePagedSearchService(2), 'webhook', makeCuratedResetService(), ONE_PER_MESSAGE);

      await runHandler(moreHandler(), makeCtx('-1001', { match: ['search_more:7:2', '7', '2'] }));

      expect(sentTexts()).toEqual(['Больше записей нет.']);
    });

    it('sends no finding messages for an empty period, just the usual explanation', async () => {
      await boot('-1001', makePagedSearchService(0), 'webhook', makeCuratedResetService(), ONE_PER_MESSAGE);

      await runHandler(periodHandler(), makeCtx('-1001'));

      const texts = sentTexts();
      expect(texts).toHaveLength(1);
      expect(texts[0]).toContain('упоминаний в пуле ссылок не найдено');
    });

    it('keeps sending the rest of the batch when one message fails', async () => {
      await boot('-1001', makePagedSearchService(3), 'webhook', makeCuratedResetService(), ONE_PER_MESSAGE);
      // Header and finding 1 go out, finding 2 fails, finding 3 must still be attempted.
      sendMessageMock.mockImplementationOnce(async () => undefined);
      sendMessageMock.mockImplementationOnce(async () => undefined);
      sendMessageMock.mockImplementationOnce(async () => {
        throw new Error('429: Too Many Requests');
      });

      await expect(runHandler(periodHandler(), makeCtx('-1001'))).resolves.toBeUndefined();

      expect(sendMessageMock).toHaveBeenCalledTimes(4);
      expect(sentTexts()[3]).toContain('3. ');
    });

    it('still delivers the "Показать ещё" button when the message it would ride on fails', async () => {
      await boot('-1001', makePagedSearchService(19), 'webhook', makeCuratedResetService(), ONE_PER_MESSAGE);
      // Header plus findings 1-7 succeed; finding 8 — the one carrying the keyboard — fails.
      for (let i = 0; i < 8; i++) {
        sendMessageMock.mockImplementationOnce(async () => undefined);
      }
      sendMessageMock.mockImplementationOnce(async () => {
        throw new Error('400: message text is too long');
      });

      await runHandler(periodHandler(), makeCtx('-1001'));

      const lastCall = sendMessageMock.mock.calls[sendMessageMock.mock.calls.length - 1] as [unknown, string, any];
      expect(lastCall[1]).toContain('Показано находок: 8 из 19');
      expect(lastCall[2].reply_markup.inline_keyboard[0][0].callback_data).toBe('search_more:7:8');
    });

    it('never puts a URL in any of the messages it sends', async () => {
      await boot('-1001', makePagedSearchService(19), 'webhook', makeCuratedResetService(), ONE_PER_MESSAGE);

      await runHandler(periodHandler(), makeCtx('-1001'));

      expect(sentTexts().join('\n')).not.toContain('http');
    });

    it('fits a full batch well inside the 60-second Vercel ceiling', async () => {
      await boot('-1001', makePagedSearchService(19), 'webhook', makeCuratedResetService(), ONE_PER_MESSAGE);
      jest.useFakeTimers();
      try {
        // Advanced in small steps and stopped the moment the handler resolves, so `elapsed` is
        // the fake time the handler actually ASKED for (8 messages => 7 pauses of 700 ms ≈ 4.9s)
        // rather than however far the test chose to push the clock.
        let settled = false;
        const promise = periodHandler()(makeCtx('-1001')).then(() => {
          settled = true;
        });
        let elapsed = 0;
        while (!settled && elapsed < 120000) {
          await jest.advanceTimersByTimeAsync(100);
          elapsed += 100;
        }
        await promise;

        expect(settled).toBe(true);
        expect(elapsed).toBeLessThan(30000);
      } finally {
        jest.useRealTimers();
      }
    });

    it('changes nothing when the flag is off — still one packed page, same button', async () => {
      const items = Array.from({ length: 3 }, (_, i) => makeMentionView({ id: `m-${i}`, title: `Находка ${i}` }));
      await boot('-1001', makeCuratedSearchService({ searchResult: { total: 50 }, page: items }));

      await periodHandler()(makeCtx('-1001'));

      expect(sendMessageMock).toHaveBeenCalledTimes(1);
      const [, message, extra] = sendMessageMock.mock.calls[0] as [unknown, string, any];
      expect(message).toContain('Упоминания за Неделя');
      expect(message).toContain('1. ');
      expect(message).toContain('3. ');
      expect(extra.reply_markup.inline_keyboard[0][0].callback_data).toBe('search_more:7:3');
    });
  });

  /**
   * Команды по вручную проверенным карточкам. Набор — отдельный от закрытого пула источник
   * данных, бот по нему ничего не ищет и не генерирует: текст берётся из JSON как есть.
   */
  describe('/curated_stats и /curated <издание>', () => {
    const curated = new CuratedMentionsService();

    /**
     * Прогон обработчика по виртуальному времени. Полная пачка — 8 сообщений, то есть 7 пауз по
     * 700 мс ≈ 4.9 с, а дефолтный таймаут jest — 5 с: на реальных таймерах эти тесты проходили
     * на самой границе и падали через раз. Шаги мелкие и цикл останавливается, как только
     * обработчик завершился, по образцу теста «fits a full batch well inside the 60-second
     * Vercel ceiling» выше.
     */
    async function runWithFakeTimers(run: () => Promise<void>): Promise<void> {
      jest.useFakeTimers();
      try {
        let settled = false;
        const promise = run().then(() => {
          settled = true;
        });
        let elapsed = 0;
        while (!settled && elapsed < 120000) {
          await jest.advanceTimersByTimeAsync(100);
          elapsed += 100;
        }
        await promise;
        expect(settled).toBe(true);
      } finally {
        jest.useRealTimers();
      }
    }

    it('регистрирует обе команды на старте', async () => {
      await boot();
      expect(commandHandlers.has('curated_stats')).toBe(true);
      expect(commandHandlers.has('curated')).toBe(true);
    });

    it('/curated_stats отдаёт общее число карточек и разбивку по тональности', async () => {
      await boot();
      const ctx = makeCtx(-1001);

      await commandHandlers.get('curated_stats')!(ctx);

      const [message] = ctx.reply.mock.calls[0] as unknown as [string, any];
      const stats = curated.stats();
      expect(message).toContain(`Всего: <b>${stats.total}</b>`);
      expect(message).toContain(`🟩 Позитив: ${stats.positive}`);
      expect(message).toContain(`🟨 Нейтрал: ${stats.neutral}`);
      expect(message).toContain(`🟥 Негатив: ${stats.negative}`);
    });

    it('/curated_stats недоступна вне рабочей группы', async () => {
      await boot();
      const ctx = makeCtx(-999);

      await commandHandlers.get('curated_stats')!(ctx);

      expect(ctx.reply).toHaveBeenCalledWith('Эта команда доступна только в рабочей группе мониторинга.');
    });

    it('/curated <издание> отправляет готовый текст карточек, по одному сообщению на карточку', async () => {
      await boot();
      const ctx = makeCtx(-1001, { message: { text: '/curated the-tenge.kz' } });
      const items = curated.bySource('the-tenge.kz');

      await commandHandlers.get('curated')!(ctx);

      // Заголовок пачки + по сообщению на каждую карточку.
      expect(sendMessageMock).toHaveBeenCalledTimes(items.length + 1);
      const [, header] = sendMessageMock.mock.calls[0] as [unknown, string, any];
      expect(header).toContain('the-tenge.kz');
      const [, first] = sendMessageMock.mock.calls[1] as [unknown, string, any];
      expect(first).toBe(curated.formatMessage(items[0]));
    });

    it('/curated у большого издания шлёт пачку с кнопкой «Показать ещё», а не все карточки разом', async () => {
      await boot();
      const ctx = makeCtx(-1001, { message: { text: '/curated sknews.kz' } });
      const items = curated.bySource('sknews.kz');
      expect(items.length).toBeGreaterThan(8);

      await runWithFakeTimers(() => commandHandlers.get('curated')!(ctx));

      // Заголовок + ровно одна пачка (8), а не все 49 сообщений сразу.
      expect(sendMessageMock).toHaveBeenCalledTimes(9);
      const [, , extra] = sendMessageMock.mock.calls[8] as [unknown, string, any];
      expect(extra.reply_markup.inline_keyboard[0][0].callback_data).toBe('curated_more:sknews.kz:8');
    });

    it('/curated all отправляет весь набор пачками, новые сверху', async () => {
      await boot();
      const ctx = makeCtx(-1001, { message: { text: '/curated all' } });
      const all = curated.sortedByDate();

      await runWithFakeTimers(() => commandHandlers.get('curated')!(ctx));

      expect(sendMessageMock).toHaveBeenCalledTimes(9); // заголовок + первая пачка из 8
      const [, header] = sendMessageMock.mock.calls[0] as [unknown, string, any];
      expect(header).toContain(`карточек: ${all.length}`);
      expect(header).toContain('показаны 1–8');
      const [, first] = sendMessageMock.mock.calls[1] as [unknown, string, any];
      expect(first).toBe(curated.formatMessage(all[0]));
      const [, , extra] = sendMessageMock.mock.calls[8] as [unknown, string, any];
      expect(extra.reply_markup.inline_keyboard[0][0].callback_data).toBe('curated_more:all:8');
    });

    it('"all" не совпадает ни с одним реальным изданием набора', () => {
      expect(curated.bySource('all')).toHaveLength(0);
    });

    it('/curated без аргумента и с неизвестным изданием подсказывает список доменов', async () => {
      await boot();

      const noArg = makeCtx(-1001, { message: { text: '/curated' } });
      await commandHandlers.get('curated')!(noArg);
      expect((noArg.reply.mock.calls[0] as unknown as [string, any])[0]).toContain('Укажите издание');

      const unknown = makeCtx(-1001, { message: { text: '/curated нет-такого.kz' } });
      await commandHandlers.get('curated')!(unknown);
      const [message] = unknown.reply.mock.calls[0] as unknown as [string, any];
      expect(message).toContain('не найдено');
      expect(message).toContain('sknews.kz');
      expect(sendMessageMock).not.toHaveBeenCalled();
    });

    it('кнопка «Показать ещё» досылает следующую пачку того же издания', async () => {
      await boot();
      const handler = actionHandlers.get(/^curated_more:.+:\d+$/.toString())!;
      const items = curated.bySource('sknews.kz');
      const ctx = makeCtx(-1001, { match: ['curated_more:sknews.kz:8'] });

      await runWithFakeTimers(() => handler(ctx));

      expect(ctx.editMessageReplyMarkup).toHaveBeenCalled();
      const [, header] = sendMessageMock.mock.calls[0] as [unknown, string, any];
      expect(header).toContain('показаны 9–16');
      const [, ninth] = sendMessageMock.mock.calls[1] as [unknown, string, any];
      expect(ninth).toBe(curated.formatMessage(items[8]));
    });
  });
});
