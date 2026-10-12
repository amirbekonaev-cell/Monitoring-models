import { Logger } from '@nestjs/common';
import {
  DEFAULT_SEARCH_MIN_DURATION_MS,
  MAX_SEARCH_MIN_DURATION_MS,
  buildSearchProgressText,
  parseSearchMinDurationMs,
  planSearchProgress,
} from './search-progress.util';

describe('parseSearchMinDurationMs', () => {
  it('не задано или пусто — 30 секунд по умолчанию', () => {
    expect(parseSearchMinDurationMs(undefined)).toBe(DEFAULT_SEARCH_MIN_DURATION_MS);
    expect(parseSearchMinDurationMs('')).toBe(DEFAULT_SEARCH_MIN_DURATION_MS);
    expect(parseSearchMinDurationMs('   ')).toBe(DEFAULT_SEARCH_MIN_DURATION_MS);
  });

  it('читает заданное значение, в том числе с пробелами по краям', () => {
    expect(parseSearchMinDurationMs('12000')).toBe(12000);
    expect(parseSearchMinDurationMs(' 5000 ')).toBe(5000);
  });

  /** Явное «отдавать сразу» — рабочее значение, а не ошибка: так возвращается прежнее поведение. */
  it('0 — выключает ожидание', () => {
    expect(parseSearchMinDurationMs('0')).toBe(0);
  });

  it('некорректное значение — предупреждение и значение по умолчанию, без исключения', () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    for (const raw of ['abc', '-1', '1.5', '30s', 'NaN']) {
      expect(parseSearchMinDurationMs(raw)).toBe(DEFAULT_SEARCH_MIN_DURATION_MS);
    }
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  /**
   * Весь /search — один 60-секундный вызов на Vercel, и отправка сообщений выдачи входит в тот же
   * потолок. Значение выше потолка дало бы не более долгий поиск, а обрыв на середине выдачи.
   */
  it('значение выше потолка зажимается до потолка', () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    expect(parseSearchMinDurationMs('120000')).toBe(MAX_SEARCH_MIN_DURATION_MS);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('planSearchProgress', () => {
  it('равные интервалы, последний кадр — в конце ожидания и ровно на 100%', () => {
    const plan = planSearchProgress(30000);
    expect(plan).toHaveLength(6);
    expect(plan.map((s) => s.atMs)).toEqual([5000, 10000, 15000, 20000, 25000, 30000]);
    expect(plan.map((s) => s.percent)).toEqual([17, 33, 50, 67, 83, 100]);
    expect(plan[plan.length - 1]).toEqual({ atMs: 30000, percent: 100 });
  });

  it('процент только растёт и не превышает 100', () => {
    for (const steps of [1, 2, 4, 6, 10]) {
      const plan = planSearchProgress(30000, steps);
      const percents = plan.map((s) => s.percent);
      expect(percents).toEqual([...percents].sort((a, b) => a - b));
      expect(Math.max(...percents)).toBe(100);
      expect(plan.map((s) => s.atMs)).toEqual([...plan.map((s) => s.atMs)].sort((a, b) => a - b));
    }
  });

  it('ждать нечего — пустое расписание, а не исключение', () => {
    expect(planSearchProgress(0)).toEqual([]);
    expect(planSearchProgress(-1)).toEqual([]);
    expect(planSearchProgress(Number.NaN)).toEqual([]);
  });

  it('некорректное число шагов откатывается к значению по умолчанию', () => {
    expect(planSearchProgress(30000, 0)).toHaveLength(6);
    expect(planSearchProgress(30000, -3)).toHaveLength(6);
  });
});

describe('buildSearchProgressText', () => {
  it('называет период и процент готовности, двумя словами', () => {
    expect(buildSearchProgressText('Неделя', 50)).toBe('Ищу упоминания за Неделя… 50%');
  });

  /**
   * Сообщение не рассказывает, как бот устроен внутри: ни про заранее собранные материалы и их
   * число, ни про ленты, ни про веб-поиск. Человек спросил упоминания за период — ему и отвечаем.
   */
  it('не выдаёт устройство поиска и не называет внутренних чисел', () => {
    const text = buildSearchProgressText('Всё время', 100).toLowerCase();
    for (const leak of ['материал', 'проверено', 'набор', 'лент', 'rss', 'openai', 'источник', 'пул']) {
      expect(text).not.toContain(leak);
    }
  });
});
