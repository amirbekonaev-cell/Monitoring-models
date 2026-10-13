import { Sentiment } from '../mentions/mention.entity';
import { ALL_TIME_PERIOD_DAYS } from '../curated/search-period.util';
import { LiveFind } from './live-find.types';
import { filterFindsToPeriod } from './live-find-period.util';

const TZ = 'Asia/Almaty';
const NOW = new Date('2026-09-20T12:00:00Z');

function find(overrides: Partial<LiveFind> = {}): LiveFind {
  return {
    title: 'QazCloud открыл дата-центр',
    url: 'https://tengrinews.kz/news/1/',
    publishedAt: new Date('2026-09-19T10:00:00Z'),
    sourceName: 'Tengrinews',
    domain: 'tengrinews.kz',
    summary: 'Пересказ.',
    sentiment: Sentiment.POSITIVE,
    ...overrides,
  };
}

/**
 * Фильтр отвечает на один вопрос: что из найденного имеет право попасть в выдачу за период.
 * Он применяется ДВА РАЗА и в разных вызовах вебхука — сразу после поиска и при развороте статей
 * по одному сообщению, — поэтому и живёт отдельной чистой функцией.
 */
describe('filterFindsToPeriod', () => {
  it('оставляет материал внутри окна периода', () => {
    expect(filterFindsToPeriod([find()], 7, NOW, TZ)).toHaveLength(1);
  });

  it('выбрасывает материал старше периода', () => {
    const old = find({ publishedAt: new Date('2026-07-15T10:00:00Z') });
    expect(filterFindsToPeriod([old], 7, NOW, TZ)).toEqual([]);
    // ...и оставляет его же за три месяца.
    expect(filterFindsToPeriod([old], 90, NOW, TZ)).toHaveLength(1);
  });

  it('за всё время не отсекает по левой границе вовсе', () => {
    const ancient = find({ publishedAt: new Date('2019-01-01T10:00:00Z') });
    expect(filterFindsToPeriod([ancient], ALL_TIME_PERIOD_DAYS, NOW, TZ)).toHaveLength(1);
  });

  it('выбрасывает материал из будущего', () => {
    const future = find({ publishedAt: new Date('2026-09-25T10:00:00Z') });
    expect(filterFindsToPeriod([future], 7, NOW, TZ)).toEqual([]);
  });

  /** Поместить материал без даты в период нечем, а соврать про период в шапке нельзя. */
  it('выбрасывает материал без даты и с нечитаемой датой', () => {
    expect(filterFindsToPeriod([find({ publishedAt: null })], 7, NOW, TZ)).toEqual([]);
    expect(filterFindsToPeriod([find({ publishedAt: new Date('не дата') })], 7, NOW, TZ)).toEqual([]);
  });

  it('схлопывает дубли по адресу, оставляя первый', () => {
    const kept = find({ title: 'Из ленты' });
    const dup = find({ title: 'Из веб-поиска', url: 'https://tengrinews.kz/news/1/?utm_source=x' });
    const result = filterFindsToPeriod([kept, dup], 7, NOW, TZ);
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe('Из ленты');
  });

  it('сортирует от новых к старым', () => {
    const older = find({ url: 'https://profit.kz/a/', publishedAt: new Date('2026-09-15T10:00:00Z') });
    const newer = find({ url: 'https://profit.kz/b/', publishedAt: new Date('2026-09-19T10:00:00Z') });
    expect(filterFindsToPeriod([older, newer], 30, NOW, TZ).map((f) => f.url)).toEqual([
      'https://profit.kz/b/',
      'https://profit.kz/a/',
    ]);
  });

  it('пустой вход — пустой выход', () => {
    expect(filterFindsToPeriod([], 7, NOW, TZ)).toEqual([]);
  });
});
