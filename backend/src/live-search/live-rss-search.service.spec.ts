import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { RssService, ParsedRssItem } from '../collectors/rss/rss.service';
import { CURATED_MENTIONS } from '../curated/curated-mentions';
import { ALL_TIME_PERIOD_DAYS } from '../curated/search-period.util';
import { LIVE_FEEDS, LiveRssSearchService } from './live-rss-search.service';

const NOW = new Date('2026-10-12T09:00:00Z');

function makeConfig(extra: Record<string, unknown> = {}): ConfigService {
  const values: Record<string, unknown> = {
    'curated.timezone': 'Asia/Almaty',
    'liveSearch.enabled': true,
    'liveSearch.rssBudgetMs': 12000,
    'liveSearch.feedTimeoutMs': 8000,
    'liveSearch.brandForms': '',
    ...extra,
  };
  return { get: jest.fn((key: string) => values[key]) } as unknown as ConfigService;
}

function item(overrides: Partial<ParsedRssItem> = {}): ParsedRssItem {
  return {
    title: 'QazCloud открыл дата-центр',
    text: 'Компания QazCloud сообщила об открытии.',
    url: 'https://the-tech.kz/novaya-statya-pro-qazcloud/',
    publishedAt: new Date('2026-10-11T10:00:00Z'),
    hash: 'h1',
    ...overrides,
  };
}

/**
 * Лента отдаёт то, что указано для её адреса; всё остальное — пусто. `byFeed` задаётся адресами
 * из live-feeds.data.json, чтобы тест проверял реальный список лент, а не выдуманный.
 */
function makeRss(byFeed: Record<string, ParsedRssItem[] | Error | 'hang'>): RssService {
  return {
    fetchFeed: jest.fn(async (feedUrl: string) => {
      const value = byFeed[feedUrl];
      if (value === undefined) {
        return [];
      }
      if (value === 'hang') {
        // Никогда не разрешается — ровно то, что сделала реальная лента на замере, несмотря на
        // выставленный rss-parser timeout.
        return new Promise<ParsedRssItem[]>(() => undefined);
      }
      if (value instanceof Error) {
        throw value;
      }
      return value;
    }),
  } as unknown as RssService;
}

const FIRST_FEED = LIVE_FEEDS[0].feedUrl;
const SECOND_FEED = LIVE_FEEDS[1].feedUrl;

describe('LiveRssSearchService', () => {
  let warn: jest.SpyInstance;
  let log: jest.SpyInstance;

  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
    log.mockRestore();
  });

  it('опрашивает каждую ленту из live-feeds.data.json ровно один раз', async () => {
    const rss = makeRss({});
    const service = new LiveRssSearchService(rss, makeConfig());

    const outcome = await service.collect(7, NOW);

    expect((rss.fetchFeed as jest.Mock).mock.calls.map(([url]) => url).sort()).toEqual(
      LIVE_FEEDS.map((f) => f.feedUrl).sort(),
    );
    expect(outcome.feedsTotal).toBe(LIVE_FEEDS.length);
    expect(outcome.feedsOk).toBe(LIVE_FEEDS.length);
    expect(outcome.finds).toEqual([]);
  });

  it('находит упоминание и подписывает его изданием из списка лент', async () => {
    const service = new LiveRssSearchService(makeRss({ [FIRST_FEED]: [item()] }), makeConfig());

    const outcome = await service.collect(7, NOW);

    expect(outcome.finds).toHaveLength(1);
    expect(outcome.finds[0]).toMatchObject({
      title: 'QazCloud открыл дата-центр',
      url: 'https://the-tech.kz/novaya-statya-pro-qazcloud/',
      sourceName: LIVE_FEEDS[0].sourceName,
      domain: LIVE_FEEDS[0].domain,
    });
    expect(outcome.itemsSeen).toBe(1);
  });

  it('пропускает материалы без названия компании', async () => {
    const service = new LiveRssSearchService(
      makeRss({ [FIRST_FEED]: [item({ title: 'В Астане открыли поликлинику', text: 'Медицина' })] }),
      makeConfig(),
    );

    const outcome = await service.collect(7, NOW);

    expect(outcome.finds).toEqual([]);
    expect(outcome.itemsSeen).toBe(1);
  });

  /** Карточка проверена человеком и уже уехала в выдаче набора — второй раз как «новое» нельзя. */
  it('не показывает то, что уже есть в наборе карточек', async () => {
    const known = CURATED_MENTIONS[0];
    const service = new LiveRssSearchService(
      makeRss({ [FIRST_FEED]: [item({ url: known.url, title: known.title })] }),
      makeConfig(),
    );

    const outcome = await service.collect(ALL_TIME_PERIOD_DAYS, NOW);

    expect(outcome.finds).toEqual([]);
    expect(outcome.alreadyKnown).toBe(1);
  });

  it('узнаёт ту же карточку по адресу с www, трекинговым параметром и без слеша на конце', async () => {
    const known = CURATED_MENTIONS[0];
    const messy = known.url.replace('https://', 'https://www.').replace(/\/$/, '') + '?utm_source=telegram';
    const service = new LiveRssSearchService(makeRss({ [FIRST_FEED]: [item({ url: messy })] }), makeConfig());

    const outcome = await service.collect(ALL_TIME_PERIOD_DAYS, NOW);

    expect(outcome.alreadyKnown).toBe(1);
    expect(outcome.finds).toEqual([]);
  });

  it('одну и ту же новость из двух лент показывает один раз', async () => {
    const service = new LiveRssSearchService(
      makeRss({ [FIRST_FEED]: [item()], [SECOND_FEED]: [item({ hash: 'h2' })] }),
      makeConfig(),
    );

    const outcome = await service.collect(7, NOW);

    expect(outcome.finds).toHaveLength(1);
    expect(outcome.itemsSeen).toBe(2);
  });

  describe('окно периода', () => {
    it('отбрасывает материал старше выбранного периода', async () => {
      const service = new LiveRssSearchService(
        makeRss({ [FIRST_FEED]: [item({ publishedAt: new Date('2026-09-01T10:00:00Z') })] }),
        makeConfig(),
      );

      expect((await service.collect(7, NOW)).finds).toEqual([]);
      expect((await service.collect(90, NOW)).finds).toHaveLength(1);
    });

    it('«Всё время» период не ограничивает', async () => {
      const service = new LiveRssSearchService(
        makeRss({ [FIRST_FEED]: [item({ publishedAt: new Date('2019-01-01T10:00:00Z') })] }),
        makeConfig(),
      );

      expect((await service.collect(ALL_TIME_PERIOD_DAYS, NOW)).finds).toHaveLength(1);
    });

    /** Поместить в период нечем, поэтому в выдачу не идёт — но и молча терять его нельзя. */
    it('материал без даты считается отдельно и не показывается', async () => {
      const service = new LiveRssSearchService(
        makeRss({ [FIRST_FEED]: [item({ publishedAt: null })] }),
        makeConfig(),
      );

      const outcome = await service.collect(7, NOW);

      expect(outcome.finds).toEqual([]);
      expect(outcome.undated).toBe(1);
    });

    it('невалидная дата из ленты не роняет проход и считается как «без даты»', async () => {
      const service = new LiveRssSearchService(
        makeRss({ [FIRST_FEED]: [item({ publishedAt: new Date('не дата') })] }),
        makeConfig(),
      );

      const outcome = await service.collect(7, NOW);

      expect(outcome.undated).toBe(1);
      expect(outcome.finds).toEqual([]);
    });
  });

  describe('неудачные сценарии', () => {
    /** ФТ-2 и то же правило, что в runCollectionCycle: одна битая лента не уносит остальные. */
    it('упавшая лента только считается — остальные обрабатываются', async () => {
      const service = new LiveRssSearchService(
        makeRss({ [FIRST_FEED]: new Error('ENOTFOUND'), [SECOND_FEED]: [item()] }),
        makeConfig(),
      );

      const outcome = await service.collect(7, NOW);

      expect(outcome.feedsFailed).toBe(1);
      expect(outcome.feedsOk).toBe(LIVE_FEEDS.length - 1);
      expect(outcome.finds).toHaveLength(1);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('ENOTFOUND'));
    });

    /**
     * Главный замеренный риск: лента не отвечает вовсе. У rss-parser выставлен timeout: 15000, и
     * на реальном прогоне он не помог — лента висела минутами. Поэтому потолок внешний, и здесь
     * проверяется именно он: проход завершается, а не висит вместе с ней.
     */
    it('зависшая лента обрывается по своему потолку, проход завершается', async () => {
      const service = new LiveRssSearchService(
        makeRss({ [FIRST_FEED]: 'hang', [SECOND_FEED]: [item()] }),
        makeConfig({ 'liveSearch.feedTimeoutMs': 50, 'liveSearch.rssBudgetMs': 5000 }),
      );

      const startedAt = Date.now();
      const outcome = await service.collect(7, NOW);

      expect(Date.now() - startedAt).toBeLessThan(2000);
      expect(outcome.feedsFailed).toBe(1);
      expect(outcome.finds).toHaveLength(1);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('не ответила'));
    });

    it('все ленты недоступны — пустая выдача и честный счёт, без исключения', async () => {
      const byFeed: Record<string, Error> = {};
      for (const feed of LIVE_FEEDS) {
        byFeed[feed.feedUrl] = new Error('сеть недоступна');
      }
      const service = new LiveRssSearchService(makeRss(byFeed), makeConfig());

      const outcome = await service.collect(7, NOW);

      expect(outcome.feedsOk).toBe(0);
      expect(outcome.feedsFailed).toBe(LIVE_FEEDS.length);
      expect(outcome.finds).toEqual([]);
    });

    it('SEARCH_LIVE_RSS=false — ни одного сетевого запроса', async () => {
      const rss = makeRss({ [FIRST_FEED]: [item()] });
      const service = new LiveRssSearchService(rss, makeConfig({ 'liveSearch.enabled': false }));

      const outcome = await service.collect(7, NOW);

      expect(rss.fetchFeed).not.toHaveBeenCalled();
      expect(outcome.feedsTotal).toBe(0);
      expect(outcome.finds).toEqual([]);
    });
  });

  it('сортирует находки от новых к старым', async () => {
    const service = new LiveRssSearchService(
      makeRss({
        [FIRST_FEED]: [
          item({ url: 'https://the-tech.kz/a-qazcloud/', publishedAt: new Date('2026-10-05T10:00:00Z') }),
          item({ url: 'https://the-tech.kz/b-qazcloud/', publishedAt: new Date('2026-10-11T10:00:00Z') }),
          item({ url: 'https://the-tech.kz/c-qazcloud/', publishedAt: new Date('2026-10-08T10:00:00Z') }),
        ],
      }),
      makeConfig(),
    );

    const outcome = await service.collect(30, NOW);

    expect(outcome.finds.map((f) => f.url)).toEqual([
      'https://the-tech.kz/b-qazcloud/',
      'https://the-tech.kz/c-qazcloud/',
      'https://the-tech.kz/a-qazcloud/',
    ]);
  });
});
