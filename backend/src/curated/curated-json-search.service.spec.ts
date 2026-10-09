/**
 * /search and /status over the ready-made cards — the source the Telegram bot actually reads.
 *
 * Two kinds of test here, deliberately:
 *  - unit tests over a small hand-built card set, where every expected number can be counted by
 *    eye from the fixture;
 *  - tests over the REAL curated-mentions.data.json, because the point of this service is that the
 *    bot answers from that file. A test that only ever sees a fixture would not notice the file
 *    being unreadable, mis-shaped, or filtered down to nothing.
 *
 * Every test asserts, directly or through the shared fetch guard below, that nothing touched the
 * network: no page download, no OpenAI call. That is the whole reason this service exists.
 */
import { ConfigService } from '@nestjs/config';
import { CuratedJsonSearchService } from './curated-json-search.service';
import { CuratedMentionsService } from './curated-mentions.service';
import { CURATED_MENTIONS, CuratedMention } from './curated-mentions';
import { subtractCalendarDays } from './curated-date.util';
import { DEFAULT_SEARCH_PERIOD_DAYS } from './search-period.util';
import { Sentiment } from '../mentions/mention.entity';

function makeConfig(overrides: Record<string, unknown> = {}): ConfigService {
  const values: Record<string, unknown> = { 'curated.timezone': 'Asia/Almaty', ...overrides };
  return { get: jest.fn((key: string) => values[key]) } as unknown as ConfigService;
}

function card(overrides: Partial<CuratedMention> = {}): CuratedMention {
  return {
    id: '1.1',
    sourceName: 'SK News',
    sourceDomain: 'sknews.kz',
    title: 'QazCloud запускает дата-центр',
    url: 'https://sknews.kz/news/view/1',
    publishedAt: '2026-09-10',
    publishedAtText: '10 сентября 2026',
    summary: 'Готовое краткое содержание материала.',
    sentiment: 'positive',
    sentimentNote: '',
    status: 'verified',
    ...overrides,
  };
}

/** A CuratedMentionsService over an arbitrary card list, bypassing the JSON file. */
function makeCards(cards: CuratedMention[]): CuratedMentionsService {
  return { all: () => cards } as unknown as CuratedMentionsService;
}

function makeService(cards: CuratedMention[], config: ConfigService = makeConfig()): CuratedJsonSearchService {
  return new CuratedJsonSearchService(makeCards(cards), config);
}

/**
 * Fails the test if anything reaches for the network. `fetch` is what both the page reader and the
 * OpenAI client use (see CuratedOpenAiReaderService / OpenAiWebSearchService), so one guard covers
 * every path out of the process.
 */
let fetchSpy: jest.SpyInstance;
beforeEach(() => {
  fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(() => {
    throw new Error('сеть не должна использоваться в /search');
  });
});
afterEach(() => {
  expect(fetchSpy).not.toHaveBeenCalled();
  fetchSpy.mockRestore();
});

describe('CuratedJsonSearchService.search', () => {
  // Пятница 2026-09-16, 12:00 по Алматы (07:00Z) — окно «Неделя» это 2026-09-09..2026-09-16.
  const now = new Date('2026-09-16T07:00:00Z');

  it('считает только карточки с датой внутри окна периода', async () => {
    const service = makeService([
      card({ id: 'in', publishedAt: '2026-09-10' }),
      card({ id: 'before', publishedAt: '2026-09-01' }),
      card({ id: 'edge-from', publishedAt: '2026-09-09' }),
      card({ id: 'edge-to', publishedAt: '2026-09-16' }),
      card({ id: 'future', publishedAt: '2026-09-17' }),
    ]);

    const result = await service.search(7, now);

    expect(result.dateFrom).toBe('2026-09-09');
    expect(result.dateTo).toBe('2026-09-16');
    expect(result.total).toBe(3); // in, edge-from, edge-to
  });

  it('карточку без даты считает отдельно и никогда не включает в период', async () => {
    const service = makeService([
      card({ id: 'undated', publishedAt: null }),
      card({ id: 'dated', publishedAt: '2026-09-10' }),
    ]);

    const result = await service.search(1, now); // окно в сутки не покрывает даже 'dated'

    expect(result.total).toBe(0);
    expect(result.undatedCount).toBe(1);
  });

  it('не показывает дубликаты — ни в выдаче, ни в статистике', async () => {
    const service = makeService([
      card({ id: '3.10', publishedAt: '2026-09-10' }),
      card({ id: '3.14', publishedAt: '2026-09-10', status: 'duplicate', duplicateOf: '3.10' }),
    ]);

    const result = await service.search(7, now);
    const page = await service.findPage(7, 0, 10, now);

    expect(result.total).toBe(1);
    expect(page.map((item) => item.id)).toEqual(['3.10']);
    expect(result.pool.cards?.duplicates).toBe(1);
    expect(result.pool.cards?.shown).toBe(1);
  });

  it('раскладывает найденное по тональности', async () => {
    const service = makeService([
      card({ id: 'a', publishedAt: '2026-09-10', sentiment: 'positive' }),
      card({ id: 'b', publishedAt: '2026-09-11', sentiment: 'positive' }),
      card({ id: 'c', publishedAt: '2026-09-12', sentiment: 'negative' }),
      card({ id: 'd', publishedAt: '2026-09-13', sentiment: 'neutral' }),
      card({ id: 'e', publishedAt: '2026-09-14', sentiment: 'undefined' }),
    ]);

    const result = await service.search(7, now);

    expect(result.bySentiment[Sentiment.POSITIVE]).toBe(2);
    expect(result.bySentiment[Sentiment.NEGATIVE]).toBe(1);
    expect(result.bySentiment[Sentiment.NEUTRAL]).toBe(1);
    expect(result.bySentiment[Sentiment.UNDEFINED]).toBe(1);
  });

  it('считает окно по календарным дням в SEARCH_TIMEZONE', async () => {
    // 2026-09-16T19:00Z — это уже 17-е в Алматы (+05), поэтому окно сдвигается на сутки вперёд.
    const service = makeService([card({ id: 'a', publishedAt: '2026-09-17' })]);

    const result = await service.search(7, new Date('2026-09-16T19:00:00Z'));

    expect(result.dateTo).toBe('2026-09-17');
    expect(result.dateFrom).toBe('2026-09-10');
    expect(result.total).toBe(1);
  });

  it('правильно переходит через февраль високосного года на длинном периоде', async () => {
    const service = makeService([
      card({ id: 'in', publishedAt: '2024-09-20' }),
      card({ id: 'out', publishedAt: '2024-09-10' }),
    ]);

    const result = await service.search(730, now);

    expect(result.dateFrom).toBe('2024-09-16');
    expect(result.total).toBe(1);
  });
});

describe('CuratedJsonSearchService.findPage', () => {
  const now = new Date('2026-09-16T07:00:00Z');

  it('сортирует по дате DESC, при равной дате — по id', async () => {
    const service = makeService([
      card({ id: 'b', publishedAt: '2026-09-10' }),
      card({ id: 'a', publishedAt: '2026-09-10' }),
      card({ id: 'newest', publishedAt: '2026-09-12' }),
    ]);

    const page = await service.findPage(7, 0, 10, now);

    expect(page.map((item) => item.id)).toEqual(['newest', 'a', 'b']);
  });

  it('применяет offset и limit, считая offset от начала всего окна', async () => {
    const service = makeService(
      ['a', 'b', 'c', 'd'].map((id, i) => card({ id, publishedAt: `2026-09-1${i}` })),
    );

    const page = await service.findPage(7, 1, 2, now);

    // Полный порядок DESC: d, c, b, a — offset 1, limit 2 даёт c, b.
    expect(page.map((item) => item.id)).toEqual(['c', 'b']);
  });

  it('отдаёт summary целиком, без обрезки до 250 символов', async () => {
    // ~50 слов — ровно то, что лежит в JSON (CURATED_SUMMARY_WORDS=50); старый лимит в 250
    // символов рвал такой текст посреди предложения.
    const summary = 'Слово '.repeat(60).trim();
    expect(summary.length).toBeGreaterThan(250);
    const service = makeService([card({ id: 'a', publishedAt: '2026-09-10', summary })]);

    const [view] = await service.findPage(7, 0, 10, now);

    expect(view.summary).toBe(summary);
    expect(view.summary).not.toContain('…');
  });

  it('показывает название издания и не отдаёт URL ни в одном поле', async () => {
    const service = makeService([
      card({ id: 'a', publishedAt: '2026-09-10', sourceName: 'Profit.kz', url: 'https://profit.kz/news/secret-path/' }),
    ]);

    const [view] = await service.findPage(7, 0, 10, now);

    expect(view.sourceLabel).toBe('Profit.kz');
    expect(JSON.stringify(view)).not.toContain('secret-path');
    expect(JSON.stringify(view)).not.toMatch(/https?:\/\//);
  });

  it('печатает дату карточки как есть, без сдвига на сутки в любом часовом поясе', async () => {
    // См. cardDate(): полночь UTC прочиталась бы как 17-е западнее Гринвича, а полдень UTC —
    // как 19-е в UTC+14, поэтому выбранный момент подгоняется под SEARCH_TIMEZONE.
    for (const timezone of ['Asia/Almaty', 'America/New_York', 'Pacific/Kiritimati']) {
      const service = makeService(
        [card({ id: 'a', publishedAt: '2026-08-18' })],
        makeConfig({ 'curated.timezone': timezone }),
      );

      const [view] = await service.findPage(3650, 0, 10, now);

      const shown = new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(view.publishedAt!);
      expect(shown).toBe('2026-08-18');
    }
  });

  it('пустой summary превращается в null, а не в пустую строку', async () => {
    const service = makeService([card({ id: 'a', publishedAt: '2026-09-10', summary: '   ' })]);

    const [view] = await service.findPage(7, 0, 10, now);

    expect(view.summary).toBeNull();
    expect(view.snippet).toBeNull();
  });

  it('пустое окно даёт пустую страницу, а не ошибку', async () => {
    const service = makeService([card({ id: 'a', publishedAt: '2020-01-01' })]);

    await expect(service.findPage(7, 0, 10, now)).resolves.toEqual([]);
  });

  it('offset за пределами окна даёт пустую страницу — кнопка "Показать ещё" не ломается', async () => {
    const service = makeService([card({ id: 'a', publishedAt: '2026-09-10' })]);

    await expect(service.findPage(7, 50, 10, now)).resolves.toEqual([]);
  });

  it('некорректные offset/limit не роняют выдачу', async () => {
    const service = makeService([card({ id: 'a', publishedAt: '2026-09-10' })]);

    await expect(service.findPage(7, -5, 10, now)).resolves.toHaveLength(1);
    await expect(service.findPage(7, 0, 0, now)).resolves.toEqual([]);
    await expect(service.findPage(7, NaN, NaN, now)).resolves.toEqual([]);
  });
});

describe('CuratedJsonSearchService.getPoolStats', () => {
  it('описывает набор карточек: размеры, дубликаты, диапазон дат, отсутствие обработки', async () => {
    const service = makeService([
      card({ id: 'a', publishedAt: '2019-05-04', status: 'verified' }),
      card({ id: 'b', publishedAt: '2026-08-18', status: 'partial' }),
      card({ id: 'c', publishedAt: null, status: 'unverified' }),
      card({ id: 'd', publishedAt: '2026-08-18', status: 'duplicate', duplicateOf: 'b' }),
    ]);

    const stats = await service.getPoolStats();

    expect(stats.cards).toEqual({
      total: 4,
      shown: 3,
      duplicates: 1,
      byStatus: { verified: 1, partial: 1, unverified: 1, duplicate: 0 },
      bySentiment: {
        [Sentiment.POSITIVE]: 3,
        [Sentiment.NEGATIVE]: 0,
        [Sentiment.NEUTRAL]: 0,
        [Sentiment.UNDEFINED]: 0,
      },
    });
    expect(stats.mentionsTotal).toBe(3);
    expect(stats.undatedMentions).toBe(1);
    // Asia/Almaty — полдень UTC здесь уже нужный день, подгонять нечего (см. cardDate).
    expect(stats.firstArticleDate).toEqual(new Date('2019-05-04T12:00:00Z'));
    expect(stats.lastArticleDate).toEqual(new Date('2026-08-18T12:00:00Z'));
    // Карточки написаны руками — «обработки» не было и не будет.
    expect(stats.lastProcessedAt).toBeNull();
  });

  it('пустой набор не ломает статистику (и бот покажет EMPTY_POOL_TEXT)', async () => {
    const stats = await makeService([]).getPoolStats();

    expect(stats.totalLinks).toBe(0);
    expect(stats.mentionsTotal).toBe(0);
    expect(stats.firstArticleDate).toBeNull();
    expect(stats.lastArticleDate).toBeNull();
  });
});

/**
 * Over the real file. These are the regression tests for the actual bug this service fixes: the
 * cards existed in curated-mentions.data.json all along, but /search read the `mentions` table and
 * so showed 2 rows instead of them.
 */
describe('CuratedJsonSearchService над настоящим curated-mentions.data.json', () => {
  const service = () => new CuratedJsonSearchService(new CuratedMentionsService(), makeConfig());

  it('«Год» на 07.10.2026 возвращает все карточки с датой ≥ 07.10.2025, без обращения к сети', async () => {
    const now = new Date('2026-10-07T07:00:00Z');
    // Ожидаемое считаем из самого файла, а не зашиваем числом: иначе тест пришлось бы править
    // при каждой правке карточки, и он перестал бы проверять согласованность.
    const expected = CURATED_MENTIONS.filter(
      (m) => m.status !== 'duplicate' && m.publishedAt !== null && m.publishedAt >= '2025-10-07',
    );
    expect(expected.length).toBeGreaterThan(0);

    const result = await service().search(365, now);
    const page = await service().findPage(365, 0, 500, now);

    expect(result.dateFrom).toBe('2025-10-07');
    expect(result.dateTo).toBe('2026-10-07');
    expect(result.total).toBe(expected.length);
    expect(page).toHaveLength(expected.length);
    expect(new Set(page.map((item) => item.id))).toEqual(new Set(expected.map((m) => m.id)));
    // Страница отсортирована по дате, новые сверху.
    const dates = page.map((item) => item.publishedAt!.toISOString());
    expect([...dates].sort().reverse()).toEqual(dates);
    // Ни одна карточка не пришла обрезанной — summary отдаётся целиком.
    for (const item of page) {
      const source = expected.find((m) => m.id === item.id)!;
      expect(item.summary).toBe(source.summary.trim());
    }
  });

  /**
   * Главная гарантия набора: для КАЖДОЙ кнопки периода выдача — это ровно те карточки, чья дата
   * статьи попала в окно. Ни одной лишней, ни одной потерянной.
   *
   * Отдельным тестом, а не только на «Год»/«10 лет», потому что именно это ломалось раньше:
   * /search ходил в таблицу `mentions`, где лежало 2 строки, и «2 месяца»/«3 месяца» отдавали
   * почти пустой ответ при 167 готовых карточках в файле. Ожидаемое снова считается из самого
   * файла — тест не надо править при добавлении карточки.
   */
  it('каждая кнопка периода отдаёт ровно те карточки, что попали в окно по дате статьи', async () => {
    const now = new Date('2026-10-07T07:00:00Z');

    for (const days of DEFAULT_SEARCH_PERIOD_DAYS) {
      const dateFrom = subtractCalendarDays('2026-10-07', days);
      const expected = CURATED_MENTIONS.filter(
        (m) =>
          m.status !== 'duplicate' &&
          m.publishedAt !== null &&
          m.publishedAt >= dateFrom &&
          m.publishedAt <= '2026-10-07',
      );

      const result = await service().search(days, now);
      const page = await service().findPage(days, 0, 500, now);

      expect({ days, from: result.dateFrom, total: result.total }).toEqual({
        days,
        from: dateFrom,
        total: expected.length,
      });
      expect(new Set(page.map((item) => item.id))).toEqual(new Set(expected.map((m) => m.id)));
    }
  });

  it('«2 месяца» и «3 месяца» находят материалы, а не пустую выдачу', async () => {
    // Якорь — самая свежая карточка в наборе: от неё оба окна гарантированно непустые, какой бы
    // ни стала дата последней статьи после правки списка.
    const newest = CURATED_MENTIONS.filter((m) => m.publishedAt !== null)
      .map((m) => m.publishedAt!)
      .sort()
      .pop()!;
    const now = new Date(`${newest}T07:00:00Z`);

    for (const days of [60, 90]) {
      const result = await service().search(days, now);
      expect(result.total).toBeGreaterThan(0);
      expect(await service().findPage(days, 0, 500, now)).toHaveLength(result.total);
    }
  });

  it('за 10 лет отдаёт все карточки с датой и ни одного дубликата', async () => {
    const now = new Date('2026-10-07T07:00:00Z');
    const dated = CURATED_MENTIONS.filter((m) => m.status !== 'duplicate' && m.publishedAt !== null);

    const result = await service().search(3650, now);

    expect(result.total).toBe(dated.length);
    expect(result.total + result.undatedCount).toBe(result.pool.cards!.shown);
  });

  it('суммы по тональности совпадают с общим числом найденного в любом периоде', async () => {
    const now = new Date('2026-10-07T07:00:00Z');

    for (const days of [7, 30, 90, 365, 730, 3650]) {
      const result = await service().search(days, now);
      const sum = Object.values(result.bySentiment).reduce((a, b) => a + b, 0);
      expect(sum).toBe(result.total);
    }
  });

  it('ни одна страница /search не содержит URL', async () => {
    const page = await service().findPage(3650, 0, 500, new Date('2026-10-07T07:00:00Z'));

    expect(page.length).toBeGreaterThan(100);
    expect(JSON.stringify(page)).not.toMatch(/https?:\/\//);
  });
});
