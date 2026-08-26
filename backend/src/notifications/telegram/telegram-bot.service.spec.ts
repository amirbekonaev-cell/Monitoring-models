import { ConfigService } from '@nestjs/config';
import { TelegramBotService } from './telegram-bot.service';
import { SettingsService } from '../../settings/settings.service';
import { SourcesService } from '../../sources/sources.service';
import { SourceKind, SourceStatus } from '../../sources/source.entity';
import { OnDemandSearchService, OnDemandSearchSummary } from '../../search-on-demand/on-demand-search.service';
import { Sentiment } from '../../mentions/mention.entity';

type CommandHandler = (ctx: any) => Promise<void>;
type ActionHandler = (ctx: any) => Promise<void>;

const commandHandlers = new Map<string, CommandHandler>();
const actionHandlers = new Map<string, ActionHandler>();
const handleUpdateMock = jest.fn(async () => undefined);
const setMyCommandsMock = jest.fn(async () => undefined);
const sendMessageMock = jest.fn(async (..._args: unknown[]) => undefined);
const catchMock = jest.fn();

jest.mock('telegraf', () => {
  const actual = jest.requireActual('telegraf');
  return {
    ...actual,
    Telegraf: jest.fn().mockImplementation(() => ({
      command: (name: string, handler: CommandHandler) => commandHandlers.set(name, handler),
      action: (pattern: RegExp, handler: ActionHandler) => actionHandlers.set(pattern.toString(), handler),
      handleUpdate: handleUpdateMock,
      catch: catchMock,
      telegram: { setMyCommands: setMyCommandsMock, sendMessage: sendMessageMock },
    })),
  };
});

jest.mock('@vercel/functions', () => ({
  // Outside Vercel, waitUntil() has no runtime to extend — the real package's own behaviour when
  // there's no request context is to just run the promise; this mock does the same so tests can
  // await the same flushPromises() pattern regardless of how the search was kicked off.
  waitUntil: (promise: Promise<unknown>) => {
    promise.catch(() => undefined);
  },
}));

/** Flushes pending microtasks — needed because the /search period handler deliberately does NOT
 * await the on-demand search (see TelegramBotService), so its result lands a few ticks later. */
function flushPromises(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function makeConfig(chatId = '-1001'): ConfigService {
  return {
    get: jest.fn((key: string) => (key === 'telegramBot.token' ? 'tok' : key === 'telegramBot.chatId' ? chatId : '')),
  } as unknown as ConfigService;
}

function makeCtx(chatId: number | string | undefined, username = 'admin') {
  return {
    chat: chatId === undefined ? undefined : { id: chatId },
    from: { id: 42, username },
    reply: jest.fn(async () => undefined),
    answerCbQuery: jest.fn(async () => undefined),
    editMessageText: jest.fn(async () => undefined),
    telegram: { sendMessage: sendMessageMock },
    match: ['search_period:7', '7'],
  };
}

function makeSourcesService(): SourcesService {
  return {
    findAll: jest.fn(async () => [
      {
        id: 's1',
        url: 'https://a.example/rss',
        type: SourceKind.RSS,
        status: SourceStatus.ACTIVE,
        lastSuccessAt: new Date('2026-08-21T10:00:00Z'),
      },
      {
        id: 's2',
        url: 'https://b.example',
        type: SourceKind.PARSER,
        status: SourceStatus.ERROR,
        lastSuccessAt: null,
      },
    ]),
  } as unknown as SourcesService;
}

function makeOnDemandSearchService(summary?: Partial<OnDemandSearchSummary>): OnDemandSearchService {
  const defaultSummary: OnDemandSearchSummary = {
    periodDays: 7,
    totalMatched: 0,
    newCount: 0,
    knownCount: 0,
    items: [],
    sourcesFailed: [],
    openAiWebSearchCalls: 1,
    ...summary,
  };
  return {
    runSearch: jest.fn(async () => defaultSummary),
  } as unknown as OnDemandSearchService;
}

describe('TelegramBotService', () => {
  beforeEach(() => {
    commandHandlers.clear();
    actionHandlers.clear();
    handleUpdateMock.mockClear();
    setMyCommandsMock.mockClear();
    sendMessageMock.mockClear();
    catchMock.mockClear();
  });

  async function boot(
    chatId = '-1001',
    onDemandSearchService: OnDemandSearchService = makeOnDemandSearchService(),
  ): Promise<{
    service: TelegramBotService;
    settingsService: SettingsService;
    onDemandSearchService: OnDemandSearchService;
  }> {
    const settingsService = {
      isCollectionEnabled: jest.fn(async () => true),
      setCollectionEnabled: jest.fn(async () => undefined),
    } as unknown as SettingsService;
    const service = new TelegramBotService(makeConfig(chatId), settingsService, makeSourcesService(), onDemandSearchService);
    await service.onModuleInit();
    return { service, settingsService, onDemandSearchService };
  }

  it('registers /status and /search on init, without starting a long-poll connection', async () => {
    await boot();
    expect(commandHandlers.has('status')).toBe(true);
    expect(commandHandlers.has('search')).toBe(true);
    // No /pause, /resume any more — there's no background collection left for them to control
    // (see README "Деплой на Vercel").
    expect(commandHandlers.has('pause')).toBe(false);
    expect(commandHandlers.has('resume')).toBe(false);
    expect(setMyCommandsMock).toHaveBeenCalled();
    // A single slow/throwing update handler must never be able to take the shared webhook
    // endpoint down for every future update too.
    expect(catchMock).toHaveBeenCalled();
  });

  it('dispatches an incoming webhook update to the underlying Telegraf instance', async () => {
    const { service } = await boot();
    const update = { update_id: 1, message: { chat: { id: -1001 }, text: '/status' } } as any;

    await service.handleUpdate(update);

    expect(handleUpdateMock).toHaveBeenCalledWith(update);
  });

  it('throws from handleUpdate when TELEGRAM_BOT_TOKEN was never configured', async () => {
    const settingsService = { isCollectionEnabled: jest.fn(async () => true) } as unknown as SettingsService;
    const config = { get: jest.fn(() => '') } as unknown as ConfigService;
    const service = new TelegramBotService(config, settingsService, makeSourcesService(), makeOnDemandSearchService());
    await service.onModuleInit();

    await expect(service.handleUpdate({} as any)).rejects.toThrow('TELEGRAM_BOT_TOKEN');
  });

  it('/status reports current state and per-channel last success', async () => {
    await boot('-1001');
    const ctx = makeCtx('-1001');

    await commandHandlers.get('status')!(ctx);

    const replied = (ctx.reply as jest.Mock).mock.calls[0]?.[0] as string;
    expect(replied).toContain('включён');
    expect(replied).toContain(SourceKind.RSS);
    expect(replied).toContain(SourceKind.PARSER);
  });

  it('rejects /status from a chat that is not the configured group (e.g. a DM to the bot)', async () => {
    const { settingsService } = await boot('-1001');
    const dmCtx = makeCtx('999999'); // some other chat_id, e.g. a private DM

    await commandHandlers.get('status')!(dmCtx);

    expect(settingsService.isCollectionEnabled).not.toHaveBeenCalled();
    expect(dmCtx.reply).toHaveBeenCalledWith('Эта команда доступна только в рабочей группе мониторинга.');
  });

  it('rejects commands when chat is entirely missing from the update', async () => {
    await boot('-1001');
    const ctx = makeCtx(undefined);

    await commandHandlers.get('status')!(ctx);

    expect(ctx.reply).toHaveBeenCalledWith('Эта команда доступна только в рабочей группе мониторинга.');
  });

  it('/search from the configured group chat shows the 5 period buttons, capped at a month', async () => {
    await boot('-1001');
    const ctx = makeCtx('-1001');

    await commandHandlers.get('search')!(ctx);

    expect(ctx.reply).toHaveBeenCalled();
    const [, extra] = (ctx.reply as jest.Mock).mock.calls[0];
    const buttons = extra.reply_markup.inline_keyboard.flat();
    expect(buttons).toHaveLength(5);
    expect(buttons.map((b: any) => b.callback_data)).toEqual(
      expect.arrayContaining(['search_period:1', 'search_period:30']),
    );
  });

  it('rejects /search from a chat that is not the configured group', async () => {
    await boot('-1001');
    const dmCtx = makeCtx('999999');

    await commandHandlers.get('search')!(dmCtx);

    expect(dmCtx.reply).toHaveBeenCalledWith('Эта команда доступна только в рабочей группе мониторинга.');
  });

  it('picking a period runs the combined on-demand search and reports a summary in chat', async () => {
    const onDemandSearchService = makeOnDemandSearchService({
      periodDays: 7,
      totalMatched: 1,
      newCount: 1,
      knownCount: 0,
      items: [
        {
          title: 'QazCloud упомянут на форуме',
          url: 'https://kz-forum.example/thread/1',
          sourceLabel: 'kz-forum.example',
          publishedAt: new Date('2026-08-20T12:00:00Z'),
          status: 'new',
          sentiment: Sentiment.POSITIVE,
        },
      ],
      sourcesFailed: [],
      openAiWebSearchCalls: 1,
    });
    await boot('-1001', onDemandSearchService);
    const ctx = makeCtx('-1001');

    await actionHandlers.get('/^search_period:(\\d+)$/')!(ctx);
    await flushPromises();

    expect(ctx.answerCbQuery).toHaveBeenCalled();
    expect(ctx.editMessageText).toHaveBeenCalledWith(expect.stringContaining('Ищу за последние 7 дней'));
    expect(onDemandSearchService.runSearch).toHaveBeenCalledWith(7);
    expect(sendMessageMock).toHaveBeenCalled();
    const [, message] = sendMessageMock.mock.calls[0];
    expect(message).toContain('kz-forum.example');
    expect(message).toContain('Всего найдено: 1');
    expect(message).toContain('🟢 Позитив');
  });

  it('shows the correct sentiment emoji and label for each of the 4 sentiment values in the /search summary', async () => {
    const onDemandSearchService = makeOnDemandSearchService({
      totalMatched: 4,
      newCount: 4,
      knownCount: 0,
      items: [
        {
          title: 'Позитивная находка',
          url: 'https://example.com/positive',
          sourceLabel: 'example.com',
          publishedAt: null,
          status: 'new',
          sentiment: Sentiment.POSITIVE,
        },
        {
          title: 'Негативная находка',
          url: 'https://example.com/negative',
          sourceLabel: 'example.com',
          publishedAt: null,
          status: 'new',
          sentiment: Sentiment.NEGATIVE,
        },
        {
          title: 'Нейтральная находка',
          url: 'https://example.com/neutral',
          sourceLabel: 'example.com',
          publishedAt: null,
          status: 'new',
          sentiment: Sentiment.NEUTRAL,
        },
        {
          title: 'Ещё не классифицированная находка',
          url: 'https://example.com/undefined',
          sourceLabel: 'example.com',
          publishedAt: null,
          status: 'new',
          sentiment: Sentiment.UNDEFINED,
        },
      ],
      sourcesFailed: [],
      openAiWebSearchCalls: 1,
    });
    await boot('-1001', onDemandSearchService);
    const ctx = makeCtx('-1001');

    await actionHandlers.get('/^search_period:(\\d+)$/')!(ctx);
    await flushPromises();

    const [, message] = sendMessageMock.mock.calls[0];
    expect(message).toContain('🟢 Позитив · ' + 'Позитивная находка');
    expect(message).toContain('🔴 Негатив · ' + 'Негативная находка');
    expect(message).toContain('🟡 Нейтрал · ' + 'Нейтральная находка');
    expect(message).toContain('⚪ Не определена · ' + 'Ещё не классифицированная находка');
  });

  it('reports explicitly when nothing was found for the chosen period', async () => {
    const onDemandSearchService = makeOnDemandSearchService({ totalMatched: 0 });
    await boot('-1001', onDemandSearchService);
    const ctx = makeCtx('-1001');

    await actionHandlers.get('/^search_period:(\\d+)$/')!(ctx);
    await flushPromises();

    const [, message] = sendMessageMock.mock.calls[0];
    expect(message).toContain('новых упоминаний не найдено');
  });

  it('waits for the search to finish before the handler resolves, so the DB connection stays open for the whole search', async () => {
    let resolveSearch!: (summary: OnDemandSearchSummary) => void;
    const slowOnDemandSearchService = {
      runSearch: jest.fn(() => new Promise<OnDemandSearchSummary>((resolve) => (resolveSearch = resolve))),
    } as unknown as OnDemandSearchService;
    await boot('-1001', slowOnDemandSearchService);
    const ctx = makeCtx('-1001');

    // The handler must NOT resolve until runSearch() does — this deploy runs the backend as a
    // Vercel "Container" function that tears down the process right after the webhook responds,
    // so a fire-and-forget search used to get its DB connection killed mid-flight
    // (TypeORM "Driver not Connected"). Awaiting here keeps the process alive for the whole search.
    let handlerResolved = false;
    const handlerPromise = actionHandlers.get('/^search_period:(\\d+)$/')!(ctx).then(() => {
      handlerResolved = true;
    });
    await flushPromises();

    expect(ctx.answerCbQuery).toHaveBeenCalled();
    expect(handlerResolved).toBe(false);
    expect(sendMessageMock).not.toHaveBeenCalled();

    resolveSearch({
      periodDays: 7,
      totalMatched: 0,
      newCount: 0,
      knownCount: 0,
      items: [],
      sourcesFailed: [],
      openAiWebSearchCalls: 1,
    });
    await handlerPromise;

    expect(handlerResolved).toBe(true);
    expect(sendMessageMock).toHaveBeenCalled();
  });

  it('rejects the period-picker callback from an unauthorized chat', async () => {
    const onDemandSearchService = makeOnDemandSearchService();
    await boot('-1001', onDemandSearchService);
    const ctx = makeCtx('999999');

    await actionHandlers.get('/^search_period:(\\d+)$/')!(ctx);

    expect(onDemandSearchService.runSearch).not.toHaveBeenCalled();
    expect(ctx.answerCbQuery).toHaveBeenCalledWith('Эта команда доступна только в рабочей группе мониторинга.');
  });
});