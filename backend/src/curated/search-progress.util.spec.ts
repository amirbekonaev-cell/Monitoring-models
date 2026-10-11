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
  it('равные интервалы, последний кадр — в конце ожидания и на всём наборе', () => {
    const plan = planSearchProgress(30000, 166);
    expect(plan).toHaveLength(6);
    expect(plan.map((s) => s.atMs)).toEqual([5000, 10000, 15000, 20000, 25000, 30000]);
    expect(plan[plan.length - 1]).toEqual({ atMs: 30000, checked: 166 });
    expect(plan.map((s) => s.checked)).toEqual([28, 55, 83, 111, 138, 166]);
  });

  it('счётчик только растёт и никогда не превышает набор', () => {
    for (const total of [1, 2, 5, 17, 166, 1000]) {
      const plan = planSearchProgress(30000, total);
      const checked = plan.map((s) => s.checked);
      expect(checked).toEqual([...checked].sort((a, b) => a - b));
      expect(Math.max(...checked)).toBe(total);
      expect(plan.map((s) => s.atMs)).toEqual([...plan.map((s) => s.atMs)].sort((a, b) => a - b));
    }
  });

  /** На наборе меньше шести карточек шесть кадров показывали бы одно число по нескольку раз. */
  it('кадров не больше, чем материалов в наборе', () => {
    expect(planSearchProgress(30000, 3)).toHaveLength(3);
    expect(planSearchProgress(30000, 1)).toEqual([{ atMs: 30000, checked: 1 }]);
  });

  it('нечего ждать или нечего считать — пустое расписание, а не исключение', () => {
    expect(planSearchProgress(0, 166)).toEqual([]);
    expect(planSearchProgress(30000, 0)).toEqual([]);
    expect(planSearchProgress(-1, 166)).toEqual([]);
    expect(planSearchProgress(30000, -5)).toEqual([]);
    expect(planSearchProgress(Number.NaN, 166)).toEqual([]);
    expect(planSearchProgress(30000, Number.POSITIVE_INFINITY)).toEqual([]);
  });
});

describe('buildSearchProgressText', () => {
  it('называет период и показывает, сколько материалов набора уже сверено', () => {
    expect(buildSearchProgressText('Неделя', 83, 166)).toBe(
      'Ищу упоминания за Неделя…\nПроверено: 83 из 166 материалов',
    );
  });

  /**
   * Бот не обходит сайты и не ищет в интернете (набор закрыт — см. CuratedJsonSearchService),
   * поэтому ни одна строка прогресса не вправе это утверждать. Тест держит формулировку.
   */
  it('не утверждает, что идёт обход сайтов или поиск в интернете', () => {
    const text = buildSearchProgressText('Всё время', 166, 166).toLowerCase();
    for (const claim of ['сайт', 'интернет', 'источник', 'лент', 'rss', 'openai', 'скачив', 'обход']) {
      expect(text).not.toContain(claim);
    }
  });
});
