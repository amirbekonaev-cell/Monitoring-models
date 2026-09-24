import { ConfigService } from '@nestjs/config';
import { TelegramBotService } from './telegram-bot.service';
import { CuratedSearchService, CuratedSearchResult, CuratedMentionView, PoolStats } from '../../curated/curated-search.service';
import { CuratedLinkStatus } from '../../curated/curated-link.entity';
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

function makeConfig(chatId = '-1001', mode: 'polling' | 'webhook' = 'webhook'): ConfigService {
  const values: Record<string, unknown> = {
    'telegramBot.token': 'tok',
    'telegramBot.chatId': chatId,
    'telegramBot.mode': mode,
    'curated.periodDays': [...DEFAULT_SEARCH_PERIOD_DAYS],
    'curated.timezone': 'Asia/Almaty',
    'curated.messageCharLimit': 3500,
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
  ): Promise<{ service: TelegramBotService; curatedSearchService: CuratedSearchService }> {
    const service = new TelegramBotService(makeConfig(chatId, mode), curatedSearchService);
    await service.onModuleInit();
    return { service, curatedSearchService };
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
    const service = new TelegramBotService(config, makeCuratedSearchService());
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
});
