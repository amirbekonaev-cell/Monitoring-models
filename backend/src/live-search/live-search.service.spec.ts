import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { Sentiment } from '../mentions/mention.entity';
import { CURATED_MENTIONS } from '../curated/curated-mentions';
import { ALL_TIME_PERIOD_DAYS } from '../curated/search-period.util';
import { LiveRssSearchService } from './live-rss-search.service';
import { OpenAiNewsSearchService } from './openai-news-search.service';
import { LiveSearchService } from './live-search.service';
import { LiveFind } from './live-find.types';

const NOW = new Date('2026-10-12T09:00:00Z');

function makeConfig(extra: Record<string, unknown> = {}): ConfigService {
  const values: Record<string, unknown> = {
    'curated.timezone': 'Asia/Almaty',
    'liveSearch.budgetMs': 27000,
    'liveSearch.brandForms': '',
    ...extra,
  };
  return { get: jest.fn((key: string) => values[key]) } as unknown as ConfigService;
}

function find(overrides: Partial<LiveFind> = {}): LiveFind {
  return {
    title: 'QazCloud открыл дата-центр',
    url: 'https://tengrinews.kz/news/a/',
    publishedAt: new Date('2026-10-10T12:00:00Z'),
    sourceName: 'Tengrinews',
    domain: 'tengrinews.kz',
    summary: null,
    sentiment: Sentiment.UNDEFINED,
    ...overrides,
  };
}

function makeRss(finds: LiveFind[] | Error): LiveRssSearchService {
  return {
    collect: jest.fn(async () => {
      if (finds instanceof Error) {
        throw finds;
      }
      return { feedsTotal: 17, feedsOk: 17, feedsFailed: 0, itemsSeen: 1760, finds, alreadyKnown: 0, undated: 0, elapsedMs: 10 };
    }),
  } as unknown as LiveRssSearchService;
}

function makeOpenAi(finds: LiveFind[] | Error): OpenAiNewsSearchService {
  return {
    available: true,
    search: jest.fn(async () => {
      if (finds instanceof Error) {
        throw finds;
      }
      return finds;
    }),
  } as unknown as OpenAiNewsSearchService;
}

describe('LiveSearchService', () => {
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

  it('складывает находки обоих каналов в один список, новые сверху', async () => {
    const service = new LiveSearchService(
      makeRss([find({ url: 'https://a.kz/1', publishedAt: new Date('2026-10-05T12:00:00Z') })]),
      makeOpenAi([find({ url: 'https://b.kz/2', publishedAt: new Date('2026-10-11T12:00:00Z') })]),
      makeConfig(),
    );

    const outcome = await service.collect(30, NOW);

    expect(outcome.finds.map((f) => f.url)).toEqual(['https://b.kz/2', 'https://a.kz/1']);
    expect(outcome.channelsOk).toBe(2);
    expect(outcome.channelsFailed).toBe(0);
  });

  it('запускает оба канала параллельно, а не один за другим', async () => {
    const slow = (ms: number) => async () => {
      await new Promise((resolve) => setTimeout(resolve, ms));
      return [] as LiveFind[];
    };
    const rss = makeRss([]);
    (rss.collect as jest.Mock).mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 120));
      return { feedsTotal: 17, feedsOk: 17, feedsFailed: 0, itemsSeen: 0, finds: [], alreadyKnown: 0, undated: 0, elapsedMs: 120 };
    });
    const openAi = makeOpenAi([]);
    (openAi.search as jest.Mock).mockImplementation(slow(120));

    const startedAt = Date.now();
    await new LiveSearchService(rss, openAi, makeConfig()).collect(7, NOW);

    // Последовательно это было бы ~240 мс.
    expect(Date.now() - startedAt).toBeLessThan(220);
  });

  describe('склейка', () => {
    it('одну и ту же статью из двух каналов показывает один раз', async () => {
      const service = new LiveSearchService(
        makeRss([find({ url: 'https://a.kz/same/' })]),
        makeOpenAi([find({ url: 'https://www.a.kz/same?utm_source=x' })]),
        makeConfig(),
      );

      expect((await service.collect(30, NOW)).finds).toHaveLength(1);
    });

    /** Материал, который бот и так показывает, не должен приехать в выдаче второй раз. */
    it('выбрасывает то, что уже есть среди показываемых материалов', async () => {
      const known = CURATED_MENTIONS[0];
      const service = new LiveSearchService(
        makeRss([find({ url: known.url, publishedAt: new Date('2026-10-10T12:00:00Z') })]),
        makeOpenAi([]),
        makeConfig(),
      );

      expect((await service.collect(ALL_TIME_PERIOD_DAYS, NOW)).finds).toEqual([]);
    });

    it('выбрасывает находки вне выбранного периода', async () => {
      const service = new LiveSearchService(
        makeRss([find({ publishedAt: new Date('2026-08-01T12:00:00Z') })]),
        makeOpenAi([]),
        makeConfig(),
      );

      expect((await service.collect(7, NOW)).finds).toEqual([]);
      expect((await service.collect(180, NOW)).finds).toHaveLength(1);
    });

    it('«Всё время» период не ограничивает', async () => {
      const service = new LiveSearchService(
        makeRss([find({ publishedAt: new Date('2019-03-01T12:00:00Z') })]),
        makeOpenAi([]),
        makeConfig(),
      );

      expect((await service.collect(ALL_TIME_PERIOD_DAYS, NOW)).finds).toHaveLength(1);
    });

    /**
     * Показать в выдаче «за неделю» материал неизвестного года — значит соврать про период,
     * указанный в шапке. Поместить его в окно нечем, поэтому он отбрасывается.
     */
    it('выбрасывает находки без даты', async () => {
      const service = new LiveSearchService(
        makeRss([find({ publishedAt: null })]),
        makeOpenAi([find({ url: 'https://b.kz/2', publishedAt: new Date('не дата') })]),
        makeConfig(),
      );

      expect((await service.collect(ALL_TIME_PERIOD_DAYS, NOW)).finds).toEqual([]);
    });

    /** У ленты дата из самого фида, у веб-поиска — восстановленная моделью; верим фиду. */
    it('при совпадении адресов оставляет запись ленты', async () => {
      const service = new LiveSearchService(
        makeRss([find({ url: 'https://a.kz/x/', sourceName: 'Из ленты' })]),
        makeOpenAi([find({ url: 'https://a.kz/x/', sourceName: 'Из веб-поиска' })]),
        makeConfig(),
      );

      expect((await service.collect(30, NOW)).finds[0].sourceName).toBe('Из ленты');
    });
  });

  describe('неудачные сценарии', () => {
    it('упавший веб-поиск не лишает выдачу находок лент', async () => {
      const service = new LiveSearchService(
        makeRss([find()]),
        makeOpenAi(new Error('rate limit')),
        makeConfig(),
      );

      const outcome = await service.collect(30, NOW);

      expect(outcome.finds).toHaveLength(1);
      expect(outcome.channelsFailed).toBe(1);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('rate limit'));
    });

    it('упавшие ленты не лишают выдачу находок веб-поиска', async () => {
      const service = new LiveSearchService(
        makeRss(new Error('сеть недоступна')),
        makeOpenAi([find()]),
        makeConfig(),
      );

      const outcome = await service.collect(30, NOW);

      expect(outcome.finds).toHaveLength(1);
      expect(outcome.channelsFailed).toBe(1);
    });

    it('упали оба канала — пустая выдача, без исключения', async () => {
      const service = new LiveSearchService(
        makeRss(new Error('ENOTFOUND')),
        makeOpenAi(new Error('HTTP 500')),
        makeConfig(),
      );

      const outcome = await service.collect(30, NOW);

      expect(outcome.finds).toEqual([]);
      expect(outcome.channelsOk).toBe(0);
      expect(outcome.channelsFailed).toBe(2);
    });
  });
});
