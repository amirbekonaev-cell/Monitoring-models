import { ConfigService } from '@nestjs/config';
import { TelegramBotService } from './telegram-bot.service';
import {
  CuratedMentionView,
  CuratedSearchResult,
  CuratedSearchSource,
  PoolStats,
} from '../../curated/curated-search.types';
import { CuratedJsonSearchService } from '../../curated/curated-json-search.service';
import { CuratedResetService } from '../../curated/curated-reset.service';
import { LiveSearchOutcome, LiveSearchService } from '../../live-search/live-search.service';
import { LiveFindStoreService } from '../../live-search/live-find-store.service';
import { LiveFind } from '../../live-search/live-find.types';
import { StoredLiveFinds } from '../../live-search/live-find-store.util';
import { DashboardPublishService } from '../../curated/dashboard-publish.service';
import { CuratedLinkStatus } from '../../curated/curated-link.entity';
import { CuratedMentionsService } from '../../curated/curated-mentions.service';
import { Sentiment } from '../../mentions/mention.entity';
import { DEFAULT_SEARCH_PERIOD_DAYS } from '../../curated/search-period.util';
import { encodeSearchPeriod, SearchPeriod } from '../../curated/search-window.util';
import {
  SEARCH_CUSTOM_RANGE_BUTTON_TEXT,
  SEARCH_CUSTOM_RANGE_CALLBACK_DATA,
  SEARCH_CUSTOM_RANGE_PROMPT_TEXT,
} from '../../curated/curated-message.util';

type CommandHandler = (ctx: any) => Promise<void>;
type ActionHandler = (ctx: any) => Promise<void>;

const commandHandlers = new Map<string, CommandHandler>();
const actionHandlers = new Map<string, ActionHandler>();
/** Обработчики bot.on(...) — сейчас это ровно один: ответ датами на вопрос про свой отрезок. */
const updateHandlers: ActionHandler[] = [];
const handleUpdateMock = jest.fn(async () => undefined);
const setMyCommandsMock = jest.fn(async () => undefined);
const sendMessageMock = jest.fn(async (..._args: unknown[]) => ({ message_id: 777 }));
const editMessageTextMock = jest.fn(async (..._args: unknown[]) => undefined);
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
      on: (_filter: unknown, handler: ActionHandler) => updateHandlers.push(handler),
      handleUpdate: handleUpdateMock,
      catch: catchMock,
      launch: launchMock,
      stop: stopMock,
      telegram: {
        setMyCommands: setMyCommandsMock,
        sendMessage: sendMessageMock,
        editMessageText: editMessageTextMock,
      },
    })),
  };
});

/**
 * Обработчик по НАЧАЛУ его регулярки, а не по её полному тексту: шаблон периода в callback_data
 * меняется (сейчас в нём, кроме дней, живёт и свой отрезок), и тесты не должны ломаться от этого
 * — они проверяют поведение, а не текст регулярного выражения.
 */
function actionHandler(prefix: string): ActionHandler {
  for (const [pattern, handler] of actionHandlers) {
    if (pattern.startsWith(prefix)) {
      return handler;
    }
  }
  throw new Error(`обработчик для ${prefix} не зарегистрирован`);
}

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
    telegram: { sendMessage: sendMessageMock, editMessageText: editMessageTextMock },
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
    url: null,
    ...overrides,
  };
}

/**
 * Перенос выдачи в дашборд. По умолчанию отрабатывает успешно и сообщает, сколько материалов
 * туда легло; тест про недоступную базу подменяет publish на падающий.
 */
function makeDashboardPublishService(published = 3): DashboardPublishService {
  return {
    publish: jest.fn(async (periodDays: number) => ({
      periodDays,
      dateFrom: '2026-07-10',
      dateTo: '2026-10-10',
      removed: 0,
      published,
    })),
    clear: jest.fn(async () => 0),
    count: jest.fn(async () => 0),
  } as unknown as DashboardPublishService;
}

function makeCuratedResetService(preview = { links: 169, mentions: 167 }): CuratedResetService {
  return {
    preview: jest.fn(async () => preview),
    reset: jest.fn(async () => ({ ...preview, mentionsDeleted: preview.mentions })),
  } as unknown as CuratedResetService;
}

/**
 * Живой поиск. По умолчанию ничего не находит — подавляющая часть тестов в этом файле проверяет
 * выдачу бота, а не сетевые каналы, и примешивать их туда нечего. Тесты живого поиска передают
 * свои находки.
 */
function makeLiveSearchService(outcome: Partial<LiveSearchOutcome> = {}): LiveSearchService {
  return {
    collect: jest.fn(async () => ({
      finds: [],
      channelsOk: 2,
      channelsFailed: 0,
      elapsedMs: 0,
      ...outcome,
    })),
  } as unknown as LiveSearchService;
}

/**
 * Хранилище находок в памяти — те же правила, что у LiveFindStoreService поверх `settings`: одна
 * запись на период, каждое сохранение заменяет её целиком.
 */
function makeLiveFindStore(seed: Record<number, LiveFind[]> = {}): LiveFindStoreService & {
  rows: Map<string, StoredLiveFinds>;
} {
  // Ключ — закодированный период, ровно как у LiveFindStoreService поверх `settings`: у своего
  // отрезка это даты, и по объекту-окну искать в Map нельзя — сравнивались бы ссылки.
  const rows = new Map<string, StoredLiveFinds>(
    Object.entries(seed).map(([days, finds]) => [
      encodeSearchPeriod(Number(days)),
      { savedAt: new Date(), finds },
    ]),
  );
  return {
    rows,
    save: jest.fn(async (period: SearchPeriod, finds: LiveFind[], now: Date = new Date()) => {
      rows.set(encodeSearchPeriod(period), { savedAt: now, finds: [...finds] });
    }),
    load: jest.fn(
      async (period: SearchPeriod) => rows.get(encodeSearchPeriod(period)) ?? { savedAt: null, finds: [] },
    ),
  } as unknown as LiveFindStoreService & { rows: Map<string, StoredLiveFinds> };
}

function makeCuratedSearchService(config: {
  pool?: Partial<PoolStats>;
  searchResult?: Partial<CuratedSearchResult>;
  page?: CuratedMentionView[];
} = {}): CuratedSearchSource {
  const pool = makePoolStats(config.pool);
  return {
    getPoolStats: jest.fn(async () => pool),
    search: jest.fn(async (periodDays: number) => makeSearchResult({ periodDays, pool, ...config.searchResult })),
    findPage: jest.fn(async () => config.page ?? []),
  } as unknown as CuratedSearchSource;
}

describe('TelegramBotService (closed-pool bot)', () => {
  beforeEach(() => {
    commandHandlers.clear();
    actionHandlers.clear();
    updateHandlers.length = 0;
    editMessageTextMock.mockClear();
    handleUpdateMock.mockClear();
    setMyCommandsMock.mockClear();
    sendMessageMock.mockClear();
    catchMock.mockClear();
    launchMock.mockClear();
    stopMock.mockClear();
  });

  async function boot(
    chatId = '-1001',
    curatedSearchService: CuratedSearchSource = makeCuratedSearchService(),
    mode: 'polling' | 'webhook' = 'webhook',
    curatedResetService: CuratedResetService = makeCuratedResetService(),
    extraConfig: Record<string, unknown> = {},
    dashboardPublishService: DashboardPublishService = makeDashboardPublishService(),
    liveSearchService: LiveSearchService = makeLiveSearchService(),
    liveFindStore: LiveFindStoreService = makeLiveFindStore(),
  ): Promise<{
    service: TelegramBotService;
    curatedSearchService: CuratedSearchSource;
    curatedResetService: CuratedResetService;
    dashboardPublishService: DashboardPublishService;
    liveSearchService: LiveSearchService;
    liveFindStore: LiveFindStoreService;
  }> {
    const service = new TelegramBotService(
      makeConfig(chatId, mode, extraConfig),
      curatedSearchService,
      curatedResetService,
      new CuratedMentionsService(),
      dashboardPublishService,
      liveSearchService,
      liveFindStore,
    );
    await service.onModuleInit();
    return {
      service,
      curatedSearchService,
      curatedResetService,
      dashboardPublishService,
      liveSearchService,
      liveFindStore,
    };
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

  /**
   * В меню ровно три команды. /curated_stats и /curated из него убраны: они дублируют то, что
   * делает /search, и только засоряли список. Обработчики при этом остались — проверено ниже, в
   * describe('/curated_stats и /curated <издание>'), — то есть команда, набранная руками, и кнопки
   * в уже отправленных сообщениях продолжают работать.
   */
  it('показывает в меню только /search, /status и /reset', async () => {
    await boot();

    const [commands] = setMyCommandsMock.mock.calls[0] as unknown as [{ command: string }[]];
    expect(commands.map((c) => c.command)).toEqual(['search', 'status', 'reset']);
    // Обработчики живы, просто не в меню.
    expect(commandHandlers.has('curated_stats')).toBe(true);
    expect(commandHandlers.has('curated')).toBe(true);
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
      makeDashboardPublishService(),
      makeLiveSearchService(),
      makeLiveFindStore(),
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
        'За какой период искать упоминания?',
        expect.anything(),
      );
      const [, extra] = (ctx.reply as jest.Mock).mock.calls[0];
      const buttons = extra.reply_markup.inline_keyboard.flat();
      // Кнопки периодов плюс «Свои даты» — свой отрезок человек вписывает сам.
      expect(buttons).toHaveLength(DEFAULT_SEARCH_PERIOD_DAYS.length + 1);
      expect(buttons[buttons.length - 1]).toEqual(
        expect.objectContaining({
          text: SEARCH_CUSTOM_RANGE_BUTTON_TEXT,
          callback_data: SEARCH_CUSTOM_RANGE_CALLBACK_DATA,
        }),
      );
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
    /**
     * Главное в этой истории: нажатая кнопка периода не только отвечает в Telegram, но и
     * переписывает дашборд веб-интерфейса под эту же выдачу. Проверяется и период (дашборд обязан
     * совпасть с сообщением), и строка-отчёт в подтверждении окна.
     */
    it('переносит выдачу за выбранный период в дашборд, ничего не дописывая в чат', async () => {
      const dashboard = makeDashboardPublishService(12);
      await boot('-1001', makeCuratedSearchService(), 'webhook', makeCuratedResetService(), {}, dashboard);
      const ctx = makeCtx('-1001', { match: ['search_period:90', '90'] });

      await actionHandler('/^search_period:')(ctx);

      // Период — окно (у кнопки это «за N дней»), третий аргумент — находки живого поиска:
      // в дашборд уезжает та же выдача, что и в чат.
      expect(dashboard.publish).toHaveBeenCalledWith({ kind: 'days', days: 90 }, expect.any(Date), []);
      // Про удачную запись в чате не сообщается — лишнего текста там быть не должно.
      const texts = (ctx.editMessageText as jest.Mock).mock.calls.map(([text]) => text as string);
      expect(texts.some((text) => text.includes('Дашборд'))).toBe(false);
      expect(texts.some((text) => text.includes('Период: 3 месяца'))).toBe(true);
    });

    /**
     * Недоступная база (на стенде её может не быть поднято вовсе) не должна стоить пользователю
     * ответа: /search читает карточки из JSON и обязан работать без неё. Но и промолчать нельзя —
     * иначе человек пойдёт искать в веб-интерфейсе то, чего туда не попало.
     */
    it('отвечает как обычно, если дашборд обновить не удалось, и честно говорит об этом', async () => {
      const dashboard = makeDashboardPublishService();
      (dashboard.publish as jest.Mock).mockRejectedValue(new Error('база недоступна'));
      await boot('-1001', makeCuratedSearchService(), 'webhook', makeCuratedResetService(), {}, dashboard);
      const ctx = makeCtx('-1001');

      await actionHandler('/^search_period:')(ctx);

      const texts = (ctx.editMessageText as jest.Mock).mock.calls.map(([text]) => text as string);
      expect(texts.some((text) => text.includes('Дашборд обновить не удалось'))).toBe(true);
      // Сама выдача при этом ушла в чат.
      expect(sendMessageMock).toHaveBeenCalled();
    });

    /**
     * Темп выдачи (SEARCH_MIN_DURATION_MS). Набор карточек фильтруется в памяти за миллисекунды,
     * и выдача, пришедшая в ту же секунду, читается как «у бота всё было заготовлено заранее».
     * Здесь проверяется ровно то, что не видно из кода: до истечения паузы в чат не уходит НИ
     * одного сообщения выдачи, а счётчик за это время успевает дойти до конца набора.
     *
     * 300 мс вместо тридцати секунд — та же логика на масштабе, который не замедляет прогон.
     */
    describe('темп выдачи (SEARCH_MIN_DURATION_MS)', () => {
      const PACING_MS = 300;

      function makeCards(total: number) {
        return makeCuratedSearchService({
          pool: {
            cards: {
              total,
              shown: total,
              duplicates: 0,
              byStatus: { verified: total, partial: 0, unverified: 0, duplicate: 0 },
              bySentiment: {
                [Sentiment.POSITIVE]: total,
                [Sentiment.NEGATIVE]: 0,
                [Sentiment.NEUTRAL]: 0,
                [Sentiment.UNDEFINED]: 0,
              },
            },
          },
          searchResult: { total: 1 },
          page: [makeMentionView()],
        });
      }

      it('держит выдачу заданное время и только потом отправляет её', async () => {
        await boot('-1001', makeCards(166), 'webhook', makeCuratedResetService(), {
          'curated.minDurationMs': PACING_MS,
        });
        const ctx = makeCtx('-1001');

        const startedAt = Date.now();
        await actionHandler('/^search_period:')(ctx);

        expect(Date.now() - startedAt).toBeGreaterThanOrEqual(PACING_MS);
        expect(sendMessageMock).toHaveBeenCalled();
      });

      it('за время ожидания показывает процент, доходящий до 100', async () => {
        await boot('-1001', makeCards(166), 'webhook', makeCuratedResetService(), {
          'curated.minDurationMs': PACING_MS,
        });
        const ctx = makeCtx('-1001');

        await actionHandler('/^search_period:')(ctx);

        const texts = (ctx.editMessageText as jest.Mock).mock.calls.map(([text]) => text as string);
        const progress = texts.filter((text) => text.includes('%'));
        expect(progress.length).toBeGreaterThan(1);
        expect(progress[progress.length - 1]).toContain('100%');
        // Подтверждение окна по-прежнему последнее, уже без процента.
        expect(texts[texts.length - 1]).toContain('Период:');
      });

      /**
       * Статус не называет внутренних чисел бота: сколько у него материалов и откуда они — его
       * устройство, а не ответ на вопрос человека.
       */
      it('в статусе нет внутренних чисел и названий каналов', async () => {
        await boot('-1001', makeCards(166), 'webhook', makeCuratedResetService(), {
          'curated.minDurationMs': PACING_MS,
        });
        const ctx = makeCtx('-1001');

        await actionHandler('/^search_period:')(ctx);

        const statuses = (ctx.editMessageText as jest.Mock).mock.calls
          .map(([text]) => String(text).toLowerCase())
          .filter((text) => text.includes('%'));
        expect(statuses.length).toBeGreaterThan(0);
        for (const status of statuses) {
          for (const leak of ['материал', 'проверено', '166', 'лент', 'набор']) {
            expect(status).not.toContain(leak);
          }
        }
      });

      /** Пустой период, отвеченный мгновенно, выглядит так же неправдоподобно, как и непустой. */
      it('выдерживает паузу и для периода без находок', async () => {
        const empty = makeCuratedSearchService({ searchResult: { total: 0 } });
        await boot('-1001', empty, 'webhook', makeCuratedResetService(), { 'curated.minDurationMs': PACING_MS });
        const ctx = makeCtx('-1001');

        const startedAt = Date.now();
        await actionHandler('/^search_period:')(ctx);

        expect(Date.now() - startedAt).toBeGreaterThanOrEqual(PACING_MS);
        expect(sendMessageMock).toHaveBeenCalled();
      });

      /**
       * Регрессия: без настройки /search отвечает ровно как до этой истории — сразу и без кадров
       * прогресса. Все остальные тесты в этом файле бутуют бота как раз без неё.
       */
      it('без SEARCH_MIN_DURATION_MS отвечает сразу и не рисует счётчик', async () => {
        await boot('-1001', makeCards(166));
        const ctx = makeCtx('-1001');

        const startedAt = Date.now();
        await actionHandler('/^search_period:')(ctx);

        expect(Date.now() - startedAt).toBeLessThan(PACING_MS);
        const texts = (ctx.editMessageText as jest.Mock).mock.calls.map(([text]) => text as string);
        expect(texts.some((text) => text.includes('Проверено:'))).toBe(false);
      });

      /** Перерисовка — косметика: её сбой не должен стоить человеку выдачи. */
      it('выдача уходит, даже если перерисовать счётчик не удалось', async () => {
        await boot('-1001', makeCards(166), 'webhook', makeCuratedResetService(), {
          'curated.minDurationMs': PACING_MS,
        });
        const ctx = makeCtx('-1001', {
          editMessageText: jest.fn(async () => {
            throw new Error('message is not modified');
          }),
        });

        await actionHandler('/^search_period:')(ctx);

        expect(sendMessageMock).toHaveBeenCalled();
      });
    });

    /**
     * Живой поиск внутри /search. Главное, что здесь проверяется, — найденное им попадает в ТОТ ЖЕ
     * список, что и всё остальное, и выдача не рассказывает человеку, каким каналом что добыто.
     * Сами каналы протестированы отдельно (live-search/*.spec.ts).
     */
    describe('живой поиск внутри /search', () => {
      const PACING_MS = 300;

      function liveFind(overrides: Record<string, unknown> = {}) {
        return {
          title: 'QazCloud открыл дата-центр',
          url: 'https://tengrinews.kz/svezhaya-statya/',
          publishedAt: new Date('2026-09-20T10:00:00Z'),
          sourceName: 'Tengrinews',
          domain: 'tengrinews.kz',
          summary: 'Короткий пересказ найденной статьи.',
          sentiment: Sentiment.POSITIVE,
          ...overrides,
        };
      }

      function bootWithLive(
        live: LiveSearchService,
        extra: Record<string, unknown> = {},
        curatedTotal = 1,
        liveFindStore: LiveFindStoreService = makeLiveFindStore(),
      ) {
        return boot(
          '-1001',
          makeCuratedSearchService({
            searchResult: { total: curatedTotal },
            page: curatedTotal > 0 ? [makeMentionView()] : [],
          }),
          'webhook',
          makeCuratedResetService(),
          extra,
          makeDashboardPublishService(),
          live,
          liveFindStore,
        );
      }

      function sentTexts(): string[] {
        return sendMessageMock.mock.calls.map(([, text]) => text as string);
      }

      it('ставит найденное в один список с остальным и считает его в «Всего»', async () => {
        await bootWithLive(makeLiveSearchService({ finds: [liveFind()] as never }));
        const ctx = makeCtx('-1001');

        await actionHandler('/^search_period:')(ctx);

        const list = sentTexts().find((text) => text.includes('Упоминания за')) as string;
        expect(list).toBeDefined();
        // Одна находка живого поиска плюс один свой материал — в шапке два.
        expect(list).toContain('Всего: 2');
        expect(list).toContain('QazCloud открыл дата-центр');
        expect(list).toContain('Tengrinews');
      });

      /** Новые сверху: список один, и порядок в нём по дате, а не по происхождению материала. */
      it('сортирует общий список по дате', async () => {
        await bootWithLive(makeLiveSearchService({ finds: [liveFind()] as never }));
        const ctx = makeCtx('-1001');

        await actionHandler('/^search_period:')(ctx);

        const list = sentTexts().find((text) => text.includes('Упоминания за')) as string;
        // makeMentionView() датирован 14.09.2026, находка — 20.09.2026, значит она первая.
        expect(list.indexOf('QazCloud открыл дата-центр')).toBeLessThan(list.indexOf('QazCloud упомянут в статье'));
      });

      /**
       * Своих материалов за период нет, а живой поиск что-то нашёл — отвечать «не найдено» нельзя:
       * найденное и есть ответ на вопрос.
       */
      it('показывает находки, даже когда за период больше ничего нет', async () => {
        await bootWithLive(makeLiveSearchService({ finds: [liveFind()] as never }), {}, 0);
        const ctx = makeCtx('-1001');

        await actionHandler('/^search_period:')(ctx);

        const texts = sentTexts();
        expect(texts.some((text) => text.includes('упоминаний не найдено'))).toBe(false);
        expect(texts.some((text) => text.includes('QazCloud открыл дата-центр'))).toBe(true);
      });

      it('ничего не нашёл — выдача как обычно, без единого лишнего сообщения', async () => {
        await bootWithLive(makeLiveSearchService());
        const ctx = makeCtx('-1001');

        await actionHandler('/^search_period:')(ctx);

        const texts = sentTexts();
        expect(texts.some((text) => text.includes('Упоминания за'))).toBe(true);
        expect(texts.some((text) => text.includes('лент'))).toBe(false);
      });

      /** Живой поиск дополняет выдачу; его падение не вправе превратить /search в ошибку. */
      it('упавший живой поиск не ломает выдачу', async () => {
        const live = makeLiveSearchService();
        (live.collect as jest.Mock).mockRejectedValue(new Error('сеть недоступна'));
        await bootWithLive(live);
        const ctx = makeCtx('-1001');

        await actionHandler('/^search_period:')(ctx);

        const texts = sentTexts();
        expect(texts.some((text) => text.includes('Упоминания за'))).toBe(true);
        expect(texts.some((text) => text.includes('Не удалось выполнить поиск'))).toBe(false);
      });

      it('живой поиск получает тот же период, что и выдача', async () => {
        const live = makeLiveSearchService();
        await bootWithLive(live);
        const ctx = makeCtx('-1001', { match: ['search_period:90', '90'] });

        await actionHandler('/^search_period:')(ctx);

        expect(live.collect).toHaveBeenCalledWith({ kind: 'days', days: 90 }, expect.any(Date));
      });

      /**
       * Суть схемы: живой поиск идёт ВНУТРИ паузы темпа выдачи, а не после неё, поэтому ожидание
       * наполнено настоящей работой и при этом ни на что не удлиняется.
       */
      it('идёт параллельно паузе, не удлиняя её', async () => {
        const live = makeLiveSearchService();
        (live.collect as jest.Mock).mockImplementation(
          async () =>
            new Promise((resolve) =>
              setTimeout(() => resolve({ finds: [], channelsOk: 2, channelsFailed: 0, elapsedMs: 200 }), 200),
            ),
        );
        await bootWithLive(live, { 'curated.minDurationMs': PACING_MS });
        const ctx = makeCtx('-1001');

        const startedAt = Date.now();
        await actionHandler('/^search_period:')(ctx);
        const elapsed = Date.now() - startedAt;

        expect(elapsed).toBeGreaterThanOrEqual(PACING_MS);
        expect(elapsed).toBeLessThan(PACING_MS + 200);
      });

      /**
       * Разворот статей по одному сообщению. Главное в этом блоке — найденное живым поиском
       * получает СВОЁ сообщение с пересказом и ссылкой, а не только строку в списке заголовков.
       *
       * Ровно это и было сломано: «Да, по одной» — отдельное нажатие и отдельный вызов вебхука, в
       * котором от живого поиска в памяти не остаётся ничего, и статьи собирались заново из одного
       * набора карточек. Статья, найденная веб-поиском, стояла в списке, но своего сообщения
       * никогда не получала.
       */
      describe('разворот статей по одному сообщению', () => {
        const eachHandler = () => actionHandler('/^search_each:');
        const eachCtx = () => makeCtx('-1001', { match: ['search_each:7:0', '7', '0'] });
        /**
         * Находка внутри недельного окна. Дата именно «сейчас», а не фиксированная: разворот
         * пересчитывает окно периода (от момента сохранения находок), и материал сентября 2026 в
         * «Неделю» не попал бы — как не попал бы и в настоящей выдаче.
         */
        const freshFind = (overrides: Record<string, unknown> = {}) =>
          liveFind({ publishedAt: new Date(), ...overrides });

        it('находка получает своё сообщение с пересказом и ссылкой', async () => {
          const store = makeLiveFindStore();
          await bootWithLive(makeLiveSearchService({ finds: [freshFind()] as never }), {}, 1, store);

          await actionHandler('/^search_period:')(makeCtx('-1001'));
          sendMessageMock.mockClear();
          await eachHandler()(eachCtx());

          const texts = sentTexts();
          // Две статьи: находка живого поиска и материал набора — по сообщению на каждую.
          expect(texts).toHaveLength(2);
          const find = texts.find((text) => text.includes('QazCloud открыл дата-центр')) as string;
          expect(find).toBeDefined();
          expect(find).toContain('Короткий пересказ найденной статьи.');
          expect(find).toContain('https://tengrinews.kz/svezhaya-statya/');
        });

        /** Нумерация и порядок — те же, что в списке заголовков: находка новее, значит первая. */
        it('нумерует статьи сквозь весь период, находку вместе с остальными', async () => {
          await bootWithLive(makeLiveSearchService({ finds: [freshFind()] as never }));

          await actionHandler('/^search_period:')(makeCtx('-1001'));
          sendMessageMock.mockClear();
          await eachHandler()(eachCtx());

          const texts = sentTexts();
          expect(texts[0]).toContain('1. ');
          expect(texts[0]).toContain('QazCloud открыл дата-центр');
          expect(texts[1]).toContain('2. ');
        });

        it('кладёт находки в хранилище под тем же периодом, что и выдача', async () => {
          const store = makeLiveFindStore();
          await bootWithLive(makeLiveSearchService({ finds: [freshFind()] as never }), {}, 1, store);

          await actionHandler('/^search_period:')(
            makeCtx('-1001', { match: ['search_period:90', '90'] }),
          );

          expect(store.save).toHaveBeenCalledWith(
            { kind: 'days', days: 90 },
            [expect.objectContaining({ url: 'https://tengrinews.kz/svezhaya-statya/' })],
            expect.any(Date),
          );
        });

        /**
         * Упавший живой поиск затирает прежние находки пустым списком: список заголовков, который
         * человек только что увидел, тоже без них, и разворот обязан показать ровно то же — иначе
         * в сообщениях всплыли бы статьи от прошлого нажатия.
         */
        it('упавший живой поиск очищает находки прошлого нажатия', async () => {
          const store = makeLiveFindStore({ 7: [freshFind() as never] });
          const live = makeLiveSearchService();
          (live.collect as jest.Mock).mockRejectedValue(new Error('сеть недоступна'));
          await bootWithLive(live, {}, 1, store);

          await actionHandler('/^search_period:')(makeCtx('-1001'));
          sendMessageMock.mockClear();
          await eachHandler()(eachCtx());

          const texts = sentTexts();
          expect(texts).toHaveLength(1);
          expect(texts[0]).not.toContain('QazCloud открыл дата-центр');
        });

        /**
         * Находка, выпавшая из периода к моменту разворота (запись в хранилище осталась от
         * прошлого нажатия, а окно отсчитывается заново), в сообщения не попадает: шапка с датами
         * и список статей не вправе разойтись.
         */
        it('не показывает находку, выпавшую из периода', async () => {
          const store = makeLiveFindStore({
            7: [liveFind({ publishedAt: new Date('2020-01-01T10:00:00Z') }) as never],
          });
          await bootWithLive(makeLiveSearchService(), {}, 1, store);

          await eachHandler()(eachCtx());

          const texts = sentTexts();
          expect(texts).toHaveLength(1);
          expect(texts[0]).not.toContain('QazCloud открыл дата-центр');
        });

        /**
         * Недоступная база — это выдача без находок, а не ошибка в чате: /search обязан отвечать
         * и с упавшим Postgres (хранилище — единственное место в этом пути, которое его трогает).
         */
        it('недоступное хранилище не ломает ни выдачу, ни разворот', async () => {
          const store = makeLiveFindStore();
          (store.save as jest.Mock).mockRejectedValue(new Error('no connection to postgres'));
          (store.load as jest.Mock).mockRejectedValue(new Error('no connection to postgres'));
          await bootWithLive(makeLiveSearchService({ finds: [freshFind()] as never }), {}, 1, store);

          await actionHandler('/^search_period:')(makeCtx('-1001'));
          // Список заголовков всё равно с находкой: она ещё в памяти этого же вызова.
          expect(sentTexts()[0]).toContain('QazCloud открыл дата-центр');

          sendMessageMock.mockClear();
          await eachHandler()(eachCtx());

          const texts = sentTexts();
          expect(texts).toHaveLength(1);
          expect(texts.join(' ')).not.toContain('Не удалось выполнить поиск');
        });

        /** Упакованные страницы («Показать ещё») считают находки так же, как поштучный поток. */
        it('упакованная страница тоже включает находку', async () => {
          const store = makeLiveFindStore({ 7: [freshFind() as never] });
          await bootWithLive(makeLiveSearchService(), {}, 1, store);

          await actionHandler('/^search_more:')(
            makeCtx('-1001', { match: ['search_more:7:0', '7', '0'] }),
          );

          expect(sentTexts()[0]).toContain('QazCloud открыл дата-центр');
        });

        /** Дашборд получает ту же выдачу, что и чат: иначе веб-интерфейс расходится с ботом. */
        it('передаёт находки в дашборд', async () => {
          const dashboard = makeDashboardPublishService();
          await boot(
            '-1001',
            makeCuratedSearchService({ searchResult: { total: 1 }, page: [makeMentionView()] }),
            'webhook',
            makeCuratedResetService(),
            {},
            dashboard,
            makeLiveSearchService({ finds: [freshFind()] as never }),
            makeLiveFindStore(),
          );

          await actionHandler('/^search_period:')(makeCtx('-1001'));

          expect(dashboard.publish).toHaveBeenCalledWith({ kind: 'days', days: 7 }, expect.any(Date), [
            expect.objectContaining({ title: 'QazCloud открыл дата-центр' }),
          ]);
        });
      });

      /**
       * Сообщения бота не рассказывают, как он устроен: ни про ленты, ни про веб-поиск, ни про
       * «набор» заранее собранных материалов, ни про то, что что-то «не проверено вручную».
       * Человек спросил упоминания за период — он и получает упоминания за период.
       */
      it('не рассказывает в чате, откуда взяты материалы', async () => {
        await bootWithLive(makeLiveSearchService({ finds: [liveFind()] as never }));
        const ctx = makeCtx('-1001');

        await actionHandler('/^search_period:')(ctx);

        const everything = [
          ...sentTexts(),
          ...(ctx.editMessageText as jest.Mock).mock.calls.map(([text]) => text as string),
        ]
          .join(' ')
          .toLowerCase();

        for (const leak of ['лент', 'rss', 'openai', 'веб-поиск', 'в наборе', 'проверено вручную', 'пул']) {
          expect(everything).not.toContain(leak);
        }
      });
    });

    it('rejects the callback from an unauthorized chat without ever touching the curated pool', async () => {
      const { curatedSearchService } = await boot('-1001');
      const ctx = makeCtx('999999');

      await actionHandler('/^search_period:')(ctx);

      expect(curatedSearchService.search).not.toHaveBeenCalled();
      expect(ctx.answerCbQuery).toHaveBeenCalledWith('Эта команда доступна только в рабочей группе мониторинга.');
    });

    it('answers "Неизвестный период" for a days value outside SEARCH_PERIOD_DAYS, without searching', async () => {
      const { curatedSearchService } = await boot('-1001');
      const ctx = makeCtx('-1001', { match: ['search_period:999999', '999999'] });

      await actionHandler('/^search_period:')(ctx);

      expect(ctx.answerCbQuery).toHaveBeenCalledWith('Неизвестный период');
      expect(curatedSearchService.search).not.toHaveBeenCalled();
    });

    it('never calls any collector or OpenAI service — /search only ever touches the search source', async () => {
      const curatedSearchService = makeCuratedSearchService();
      await boot('-1001', curatedSearchService);
      const ctx = makeCtx('-1001');
      // fetch is the single way out of the process for both the page reader and the OpenAI client
      // (CuratedOpenAiReaderService / OpenAiWebSearchService), so one guard covers every path.
      const fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(() => {
        throw new Error('сеть не должна использоваться в /search');
      });

      try {
        await actionHandler('/^search_period:')(ctx);

        expect(curatedSearchService.search).toHaveBeenCalledWith({ kind: 'days', days: 7 }, expect.any(Date));
        expect(fetchSpy).not.toHaveBeenCalled();
      } finally {
        fetchSpy.mockRestore();
      }

      // The real assertion is structural (see the constructor signature in telegram-bot.service.ts):
      // the bot depends on the CuratedSearchSource interface, so it has no way to reach
      // CuratedIngestService, CuratedOpenAiReaderService, OpenAiWebSearchService or any collector —
      // nor does it need an OPENAI_API_KEY, which makeConfig() above never supplies.
      expect(Object.keys(makeCuratedSearchService()).sort()).toEqual(['findPage', 'getPoolStats', 'search']);
    });

    it('/status тоже ничего не качает и обходится без OPENAI_API_KEY', async () => {
      await boot('-1001', makeCuratedSearchService());
      const ctx = makeCtx('-1001');
      const fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(() => {
        throw new Error('сеть не должна использоваться в /status');
      });

      try {
        await commandHandlers.get('status')!(ctx);

        expect(ctx.reply).toHaveBeenCalled();
        expect(fetchSpy).not.toHaveBeenCalled();
      } finally {
        fetchSpy.mockRestore();
      }
    });

    // The status line goes out before search() and is replaced by the window confirmation after —
    // feedback that the right button was registered, nothing more. It must no longer claim the bot
    // is reading source pages or that this may take half a minute: it reads ready-made cards.
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

      await actionHandler('/^search_period:')(ctx);

      expect(order).toEqual(['status', 'search', 'result']);
    });

    // Both lines described work the bot no longer does: it processes no sources and has no queue.
    it('never reports processed sources or a pending queue', async () => {
      await boot(
        '-1001',
        makeCuratedSearchService({
          searchResult: { total: 1 },
          pool: {
            byStatus: {
              [CuratedLinkStatus.PENDING]: 2,
              [CuratedLinkStatus.PROCESSED]: 165,
              [CuratedLinkStatus.NOT_RELEVANT]: 0,
              [CuratedLinkStatus.FAILED]: 1,
              [CuratedLinkStatus.EXCLUDED]: 0,
            },
          },
          page: [makeMentionView()],
        }),
      );
      const ctx = makeCtx('-1001');

      await actionHandler('/^search_period:')(ctx);

      for (const call of (ctx.editMessageText as jest.Mock).mock.calls) {
        expect(String(call[0])).not.toContain('Обработано источников');
        expect(String(call[0])).not.toContain('это может занять');
      }
      const [, message] = sendMessageMock.mock.calls[0] as [unknown, string];
      expect(message).not.toContain('В очереди на обработку');
    });

    it('still runs the search when the status edit fails (an old message can no longer be edited)', async () => {
      const curatedSearchService = makeCuratedSearchService();
      await boot('-1001', curatedSearchService);
      const ctx = makeCtx('-1001');
      ctx.editMessageText = jest
        .fn()
        .mockRejectedValueOnce(new Error('message is not modified'))
        .mockResolvedValue(undefined) as unknown as typeof ctx.editMessageText;

      await actionHandler('/^search_period:')(ctx);

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

      await actionHandler('/^search_period:')(ctx);

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

      await actionHandler('/^search_period:')(ctx);

      const [, message] = sendMessageMock.mock.calls[0];
      expect(message).toBe('Упоминаний не найдено.');
    });

    it('answers one short line when the window is empty, with no internal statistics', async () => {
      const curatedSearchService = makeCuratedSearchService({
        pool: { byStatus: { [CuratedLinkStatus.PENDING]: 0, [CuratedLinkStatus.PROCESSED]: 169, [CuratedLinkStatus.NOT_RELEVANT]: 0, [CuratedLinkStatus.FAILED]: 0, [CuratedLinkStatus.EXCLUDED]: 0 }, lastArticleDate: new Date('2026-08-01T00:00:00Z') },
        searchResult: { total: 0 },
      });
      await boot('-1001', curatedSearchService);
      const ctx = makeCtx('-1001');

      await actionHandler('/^search_period:')(ctx);

      const [, message] = sendMessageMock.mock.calls[0];
      // Одна строка, без внутренней статистики: числа остались в /status.
      expect(message).toBe('За Неделя упоминаний не найдено.');
      expect(message).not.toMatch(/https?:\/\//);
    });

    it('не печатает в шапке ни материалов без даты, ни очереди обработки', async () => {
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

      await actionHandler('/^search_period:')(ctx);

      const [, message] = sendMessageMock.mock.calls[0];
      expect(message).not.toContain('Без даты');
      expect(message).not.toContain('В очереди на обработку');
    });

    /**
     * Нажатая кнопка периода отвечает СПИСКОМ заголовков, а не сразу карточками: сначала обзор
     * «что нашлось и сколько», потом вопрос, разворачивать ли статьи по одной.
     */
    it('отвечает списком заголовков с тональностью, без пересказов и без ссылок', async () => {
      const items = Array.from({ length: 3 }, (_, i) =>
        makeMentionView({
          id: `m-${i}`,
          title: `Находка ${i}`,
          sentiment: Sentiment.NEUTRAL,
          summary: 'Этот пересказ в список попадать не должен.',
          url: `https://example.com/article-${i}`,
        }),
      );
      const curatedSearchService = makeCuratedSearchService({ searchResult: { total: 3 }, page: items });
      await boot('-1001', curatedSearchService);
      const ctx = makeCtx('-1001');

      await actionHandler('/^search_period:')(ctx);

      const [, message] = sendMessageMock.mock.calls[0] as [unknown, string, any];
      expect(message).toContain('🟡 Нейтрал');
      for (const i of [0, 1, 2]) {
        expect(message).toContain(`Находка ${i}`);
      }
      // Обзор — только заголовки: ни пересказа, ни ссылки.
      expect(message).not.toContain('Этот пересказ');
      expect(message).not.toMatch(/https?:\/\//);
    });

    it('после списка спрашивает, выводить ли статьи по одной, кнопками Да/Нет', async () => {
      const curatedSearchService = makeCuratedSearchService({
        searchResult: { total: 3 },
        page: [
          makeMentionView({ id: 'm-1' }),
          makeMentionView({ id: 'm-2' }),
          makeMentionView({ id: 'm-3' }),
        ],
      });
      await boot('-1001', curatedSearchService);
      const ctx = makeCtx('-1001');

      await actionHandler('/^search_period:')(ctx);

      const [, prompt, extra] = sendMessageMock.mock.calls.at(-1) as [unknown, string, any];
      expect(prompt).toContain('Показать каждую статью подробнее?');
      expect(prompt).toContain('Найдено: 3');
      const [[yes], [no]] = extra.reply_markup.inline_keyboard;
      expect(yes.callback_data).toBe('search_each:7:0');
      expect(no.callback_data).toBe('search_each:no');
    });

    it('«Нет» закрывает вопрос и ничего больше не отправляет', async () => {
      const curatedSearchService = makeCuratedSearchService();
      await boot('-1001', curatedSearchService);
      const ctx = makeCtx('-1001');

      await actionHandlers.get('search_each:no')!(ctx);

      expect(ctx.editMessageText).toHaveBeenCalledWith('Хорошо — оставляю только список заголовков.');
      expect(sendMessageMock).not.toHaveBeenCalled();
      expect(curatedSearchService.findPage).not.toHaveBeenCalled();
    });

    it('does not throw and reports a clear error (no stack trace, no URL) when the DB read fails', async () => {
      const curatedSearchService = {
        getPoolStats: jest.fn(async () => makePoolStats()),
        search: jest.fn(async () => {
          throw new Error('connection terminated unexpectedly');
        }),
        findPage: jest.fn(async () => []),
      } as unknown as CuratedSearchSource;
      await boot('-1001', curatedSearchService);
      const ctx = makeCtx('-1001');

      await actionHandler('/^search_period:')(ctx);

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
      } as unknown as CuratedSearchSource;
      await boot('-1001', slowCuratedSearchService);
      const ctx = makeCtx('-1001');

      let handlerResolved = false;
      const handlerPromise = actionHandler('/^search_period:')(ctx).then(() => {
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

  /**
   * Свой отрезок времени в боте — то же, что «Свои даты» в веб-интерфейсе.
   *
   * Спросить можно двумя способами, и оба проверяются здесь: командой с датами
   * (`/search 01.07.2026-15.10.2026`) и ответом датами на вопрос бота по кнопке «Свои даты».
   * Состояния «жду даты» нигде нет: ответ узнаётся по `reply_to_message` — на Vercel следующее
   * сообщение приходит в другой вызов функции, и запоминать ожидание было бы негде.
   */
  describe('свой отрезок времени', () => {
    const periodButtonHandler = () => actionHandler('/^search_period:');
    const customHandler = () => actionHandlers.get(SEARCH_CUSTOM_RANGE_CALLBACK_DATA)!;
    const textHandler = () => updateHandlers[0];

    function replyCtx(text: string, chatId: string | number = '-1001') {
      return makeCtx(chatId, {
        message: { text, reply_to_message: { text: SEARCH_CUSTOM_RANGE_PROMPT_TEXT } },
      });
    }

    function commandCtx(text: string, chatId: string | number = '-1001') {
      return makeCtx(chatId, { message: { text } });
    }

    function sentTexts(): string[] {
      return sendMessageMock.mock.calls.map((call) => call[1] as string);
    }

    async function bootWithWindow(total = 1) {
      return boot('-1001', makeCuratedSearchService({ searchResult: { total }, page: [makeMentionView()] }));
    }

    it('ищет по датам из команды /search', async () => {
      const { curatedSearchService } = await bootWithWindow();

      await commandHandlers.get('search')!(commandCtx('/search 01.07.2026-15.10.2026'));

      expect(curatedSearchService.search).toHaveBeenCalledWith(
        { kind: 'range', dateFrom: '2026-07-01', dateTo: '2026-10-15' },
        expect.any(Date),
      );
    });

    /** Кнопки периодов тогда не нужны вовсе: период уже назван. */
    it('команда с датами не показывает клавиатуру периодов', async () => {
      await bootWithWindow();
      const ctx = commandCtx('/search 01.07.2026-15.10.2026');

      await commandHandlers.get('search')!(ctx);

      const replies = (ctx.reply as jest.Mock).mock.calls;
      expect(replies.every(([, extra]) => extra?.reply_markup?.inline_keyboard === undefined)).toBe(true);
    });

    it('в шапке выдачи стоят сами даты, а не название периода', async () => {
      await bootWithWindow();

      await commandHandlers.get('search')!(commandCtx('/search 01.07.2026-15.10.2026'));

      const list = sentTexts().find((text) => text.includes('Упоминания за')) as string;
      expect(list).toContain('01.07.2026 — 15.10.2026');
    });

    it('кнопка «Свои даты» задаёт вопрос с force_reply и снимает клавиатуру периодов', async () => {
      await bootWithWindow();
      const ctx = makeCtx('-1001');

      await customHandler()(ctx);

      expect(ctx.editMessageReplyMarkup).toHaveBeenCalledWith({ inline_keyboard: [] });
      const [text, extra] = (ctx.reply as jest.Mock).mock.calls[0];
      expect(text).toBe(SEARCH_CUSTOM_RANGE_PROMPT_TEXT);
      expect(extra.reply_markup.force_reply).toBe(true);
    });

    it('ищет по датам из ответа на вопрос бота', async () => {
      const { curatedSearchService } = await bootWithWindow();

      await textHandler()(replyCtx('01.07.2026 - 15.10.2026'));

      expect(curatedSearchService.search).toHaveBeenCalledWith(
        { kind: 'range', dateFrom: '2026-07-01', dateTo: '2026-10-15' },
        expect.any(Date),
      );
    });

    /**
     * В рабочей группе люди переписываются. Поиск на каждое сообщение с цифрами бот запускать не
     * вправе — отсюда требование ответа именно на свой вопрос.
     */
    it('не реагирует на обычное сообщение с датами, не адресованное ему', async () => {
      const { curatedSearchService } = await bootWithWindow();

      await textHandler()(makeCtx('-1001', { message: { text: '01.07.2026-15.10.2026' } }));
      await textHandler()(
        makeCtx('-1001', { message: { text: '01.07.2026', reply_to_message: { text: 'Упоминания за Неделя' } } }),
      );

      expect(curatedSearchService.search).not.toHaveBeenCalled();
      expect(sendMessageMock).not.toHaveBeenCalled();
    });

    it('не отвечает на ответ из чужого чата', async () => {
      const { curatedSearchService } = await bootWithWindow();

      await textHandler()(replyCtx('01.07.2026-15.10.2026', '999999'));

      expect(curatedSearchService.search).not.toHaveBeenCalled();
    });

    it('живой поиск и дашборд получают тот же отрезок, что и выдача', async () => {
      const dashboard = makeDashboardPublishService();
      const live = makeLiveSearchService();
      await boot(
        '-1001',
        makeCuratedSearchService({ searchResult: { total: 1 }, page: [makeMentionView()] }),
        'webhook',
        makeCuratedResetService(),
        {},
        dashboard,
        live,
      );

      await commandHandlers.get('search')!(commandCtx('/search 01.07.2026-15.10.2026'));

      const range = { kind: 'range', dateFrom: '2026-07-01', dateTo: '2026-10-15' };
      expect(live.collect).toHaveBeenCalledWith(range, expect.any(Date));
      expect(dashboard.publish).toHaveBeenCalledWith(range, expect.any(Date), []);
    });

    /** Кнопки продолжения несут тот же отрезок: иначе «Показать ещё» ушло бы в другой период. */
    it('кнопка разворота несёт в себе сам отрезок', async () => {
      await bootWithWindow();

      await commandHandlers.get('search')!(commandCtx('/search 01.07.2026-15.10.2026'));

      const prompt = sendMessageMock.mock.calls.find(([, text]) =>
        String(text).includes('Показать каждую статью подробнее?'),
      ) as [unknown, string, any];
      expect(prompt[2].reply_markup.inline_keyboard[0][0].callback_data).toBe(
        'search_each:2026-07-01~2026-10-15:0',
      );
    });

    it('разворот по кнопке с отрезком выдаёт статьи того же отрезка', async () => {
      const { curatedSearchService } = await bootWithWindow();

      await actionHandler('/^search_each:')(
        makeCtx('-1001', {
          match: ['search_each:2026-07-01~2026-10-15:0', '2026-07-01~2026-10-15', '0'],
        }),
      );

      expect(curatedSearchService.search).toHaveBeenCalledWith(
        { kind: 'range', dateFrom: '2026-07-01', dateTo: '2026-10-15' },
        expect.any(Date),
      );
    });

    describe('неудачный ввод', () => {
      it('непонятные даты — причина и подсказка, без поиска', async () => {
        const { curatedSearchService } = await bootWithWindow();
        const ctx = commandCtx('/search с июля по октябрь');

        await commandHandlers.get('search')!(ctx);

        const [text] = (ctx.reply as jest.Mock).mock.calls[0];
        expect(text).toContain('Не понял даты');
        expect(text).toContain('01.07.2026-15.10.2026');
        expect(curatedSearchService.search).not.toHaveBeenCalled();
      });

      it('перевёрнутый отрезок — поиск не запускается', async () => {
        const { curatedSearchService } = await bootWithWindow();
        const ctx = replyCtx('15.10.2026-01.07.2026');

        await textHandler()(ctx);

        expect((ctx.reply as jest.Mock).mock.calls[0][0]).toContain('позже конца');
        expect(curatedSearchService.search).not.toHaveBeenCalled();
      });

      it('пустой отрезок отвечает «не найдено», а не молчанием', async () => {
        await boot('-1001', makeCuratedSearchService({ searchResult: { total: 0 }, page: [] }));

        await commandHandlers.get('search')!(commandCtx('/search 01.01.2019-02.01.2019'));

        expect(sentTexts().some((text) => text.includes('упоминаний не найдено'))).toBe(true);
      });

      /** Отрезок не из списка кнопок — это нормально, а вот число дней не из списка нормально не */
      it('подделанный период в кнопке отклоняется', async () => {
        const { curatedSearchService } = await bootWithWindow();
        const ctx = makeCtx('-1001', { match: ['search_period:12345', '12345'] });

        await periodButtonHandler()(ctx);

        expect(ctx.answerCbQuery).toHaveBeenCalledWith('Неизвестный период');
        expect(curatedSearchService.search).not.toHaveBeenCalled();
      });
    });
  });

  describe('search_more callback (pagination)', () => {
    function makeMoreCtx(chatId: number | string | undefined, days: number, offset: number) {
      return makeCtx(chatId, { match: [`search_more:${days}:${offset}`, String(days), String(offset)] });
    }

    it('rejects the callback from an unauthorized chat', async () => {
      const { curatedSearchService } = await boot('-1001');
      const ctx = makeMoreCtx('999999', 7, 3);

      await actionHandler('/^search_more:')(ctx);

      expect(curatedSearchService.findPage).not.toHaveBeenCalled();
      expect(ctx.answerCbQuery).toHaveBeenCalledWith('Эта команда доступна только в рабочей группе мониторинга.');
    });

    it('answers "Некорректный запрос" for a days value outside SEARCH_PERIOD_DAYS', async () => {
      const { curatedSearchService } = await boot('-1001');
      const ctx = makeMoreCtx('-1001', 999999, 0);

      await actionHandler('/^search_more:')(ctx);

      expect(ctx.answerCbQuery).toHaveBeenCalledWith('Некорректный запрос');
      expect(curatedSearchService.findPage).not.toHaveBeenCalled();
    });

    it('clears the keyboard on the previous message, fetches the next page at the given offset, and reports the correct remaining count', async () => {
      // Окно из пяти материалов целиком: смещение теперь применяется к общему списку, а не к
      // запросу, поэтому источник обязан отдавать окно так же, как отдаёт его бот в жизни.
      const window = Array.from({ length: 5 }, (_, i) => makeMentionView({ id: `m-${i}`, title: `Находка ${i}` }));
      const curatedSearchService = makeCuratedSearchService({
        searchResult: { total: window.length },
        page: window,
      });
      await boot('-1001', curatedSearchService);
      const ctx = makeMoreCtx('-1001', 7, 4);

      await actionHandler('/^search_more:')(ctx);

      expect(ctx.answerCbQuery).toHaveBeenCalled();
      expect(ctx.editMessageReplyMarkup).toHaveBeenCalledWith({ inline_keyboard: [] });
      // Окно читается целиком и уже потом нарезается по смещению: в общем списке материалы
      // стоят вперемешку с находками живого поиска, и страницу №N иначе не собрать (periodItems).
      expect(curatedSearchService.findPage).toHaveBeenCalledWith(
        { kind: 'days', days: 7 },
        0,
        expect.any(Number),
        expect.any(Date),
      );
      const [, message, extra] = sendMessageMock.mock.calls[0] as [unknown, string, any];
      expect(message).toContain('5. '); // startIndex = offset + 1
      expect(message).toContain('Находка 4');
      expect(extra.reply_markup).toBeUndefined(); // 4 (offset) + 1 (shown) = 5 = total -> nothing left
    });

    it('sends a "no more records" message instead of an empty Telegram message when the offset is already past the end', async () => {
      const curatedSearchService = makeCuratedSearchService({ searchResult: { total: 2 }, page: [] });
      await boot('-1001', curatedSearchService);
      const ctx = makeMoreCtx('-1001', 7, 2);

      await actionHandler('/^search_more:')(ctx);

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
    function makePagedSearchService(total: number): CuratedSearchSource {
      const pool = makePoolStats();
      const all = Array.from({ length: total }, (_, i) => makeMentionView({ id: `m-${i}`, title: `Находка ${i}` }));
      return {
        getPoolStats: jest.fn(async () => pool),
        search: jest.fn(async (periodDays: number) => makeSearchResult({ periodDays, pool, total })),
        findPage: jest.fn(async (_days: number, offset: number, limit: number) => all.slice(offset, offset + limit)),
      } as unknown as CuratedSearchSource;
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

    const periodHandler = () => actionHandler('/^search_period:');
    const moreHandler = () => actionHandler('/^search_more:');
    /** «Да, по одной» и её продолжение — поток, на который теперь указывает кнопка. */
    const eachHandler = () => actionHandler('/^search_each:');

    function sentTexts(): string[] {
      return sendMessageMock.mock.calls.map((call) => call[1] as string);
    }

    it('со включённым флагом не спрашивает: список, затем каждая находка отдельным сообщением', async () => {
      await boot('-1001', makePagedSearchService(3), 'webhook', makeCuratedResetService(), ONE_PER_MESSAGE);

      await runHandler(periodHandler(), makeCtx('-1001'));

      const texts = sentTexts();
      expect(texts).toHaveLength(4); // список + 3 находки
      expect(texts[0]).toContain('Упоминания за Неделя');
      expect(texts[0]).toContain('Всего: 3');
      // Вопроса нет — флаг означает «разворачивать сразу».
      expect(texts.join('\n')).not.toContain('Вывести каждую статью');
      expect(texts[1]).toContain('1. ');
      expect(texts[1]).toContain('Находка 0');
      expect(texts[2]).toContain('2. ');
      expect(texts[3]).toContain('3. ');
    });

    it('stops at SEARCH_ITEMS_PER_BATCH and offers the rest behind a search_each button', async () => {
      await boot('-1001', makePagedSearchService(19), 'webhook', makeCuratedResetService(), ONE_PER_MESSAGE);

      await runHandler(periodHandler(), makeCtx('-1001'));

      expect(sentTexts()).toHaveLength(9); // список + 8 находок
      // Кнопка едет на последней находке пачки и продолжает ИМЕННО поштучный поток (search_each),
      // а не упакованные страницы.
      const last = sendMessageMock.mock.calls[8] as [unknown, string, any];
      const button = last[2].reply_markup.inline_keyboard[0][0];
      expect(button.text).toBe('Показать ещё (осталось 11)');
      expect(button.callback_data).toBe('search_each:7:8');
      // ...и ни на одной из предыдущих.
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
      // Главное здесь — ровно 19 статей, по одной, без дублей и пропусков (проверено выше).
      // Смещение при этом применяется к общему списку, а не к запросу: окно каждый раз читается
      // целиком, потому что в нём вперемешку стоят находки живого поиска — см. periodItems.
      const week = { kind: 'days', days: 7 };
      expect((curatedSearchService.findPage as jest.Mock).mock.calls).toEqual([
        [week, 0, total, expect.any(Date)],
        [week, 0, total, expect.any(Date)],
        [week, 0, total, expect.any(Date)],
      ]);
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
      expect(texts[0]).toBe('За Неделя упоминаний не найдено.');
    });

    it('keeps sending the rest of the batch when one message fails', async () => {
      await boot('-1001', makePagedSearchService(3), 'webhook', makeCuratedResetService(), ONE_PER_MESSAGE);
      // Header and finding 1 go out, finding 2 fails, finding 3 must still be attempted.
      sendMessageMock.mockImplementationOnce(async () => ({ message_id: 0 }));
      sendMessageMock.mockImplementationOnce(async () => ({ message_id: 0 }));
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
        sendMessageMock.mockImplementationOnce(async () => ({ message_id: 0 }));
      }
      sendMessageMock.mockImplementationOnce(async () => {
        throw new Error('400: message text is too long');
      });

      await runHandler(periodHandler(), makeCtx('-1001'));

      const lastCall = sendMessageMock.mock.calls[sendMessageMock.mock.calls.length - 1] as [unknown, string, any];
      expect(lastCall[1]).toContain('Показано находок: 8 из 19');
      expect(lastCall[2].reply_markup.inline_keyboard[0][0].callback_data).toBe('search_each:7:8');
    });

    /**
     * Граница приватности в одном месте: ссылку печатает только сообщение про одну статью, и
     * только если источник её дал. У закрытого пула (CuratedSearchService) url всегда null —
     * именно это и значит `url: null` в makeMentionView по умолчанию.
     */
    it('не печатает ссылку, когда источник её не дал (это поведение закрытого пула)', async () => {
      await boot('-1001', makePagedSearchService(19), 'webhook', makeCuratedResetService(), ONE_PER_MESSAGE);

      await runHandler(periodHandler(), makeCtx('-1001'));

      expect(sentTexts().join('\n')).not.toContain('http');
    });

    it('печатает ссылку в сообщении про статью — и только в нём, не в списке заголовков', async () => {
      const withUrl = (total: number): CuratedSearchSource => {
        const pool = makePoolStats();
        const all = Array.from({ length: total }, (_, i) =>
          makeMentionView({ id: `m-${i}`, title: `Находка ${i}`, url: `https://example.com/a-${i}` }),
        );
        return {
          getPoolStats: jest.fn(async () => pool),
          search: jest.fn(async (periodDays: number) => makeSearchResult({ periodDays, pool, total })),
          findPage: jest.fn(async (_d: number, offset: number, limit: number) => all.slice(offset, offset + limit)),
        } as unknown as CuratedSearchSource;
      };
      await boot('-1001', withUrl(2), 'webhook', makeCuratedResetService(), ONE_PER_MESSAGE);

      await runHandler(periodHandler(), makeCtx('-1001'));

      const texts = sentTexts();
      expect(texts[0]).not.toMatch(/https?:\/\//); // список заголовков — без ссылок
      expect(texts[1]).toContain('🔗 https://example.com/a-0');
      expect(texts[2]).toContain('🔗 https://example.com/a-1');
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

    it('с выключенным флагом сначала спрашивает — статьи уходят только после «Да»', async () => {
      const curatedSearchService = makePagedSearchService(3);
      await boot('-1001', curatedSearchService);

      await runHandler(periodHandler(), makeCtx('-1001'));

      // Список + вопрос, но ни одной статьи.
      let texts = sentTexts();
      expect(texts).toHaveLength(2);
      expect(texts[0]).toContain('Упоминания за Неделя');
      expect(texts[1]).toContain('Показать каждую статью подробнее?');

      await runHandler(eachHandler(), makeCtx('-1001', { match: ['search_each:7:0', '7', '0'] }));

      texts = sentTexts();
      expect(texts).toHaveLength(5); // список + вопрос + 3 статьи
      expect(texts[2]).toContain('Находка 0');
      expect(texts[4]).toContain('Находка 2');
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
