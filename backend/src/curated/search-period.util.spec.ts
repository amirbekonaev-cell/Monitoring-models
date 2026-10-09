import {
  ALL_TIME_PERIOD_DAYS,
  DEFAULT_SEARCH_PERIOD_DAYS,
  MAX_SEARCH_PERIOD_DAYS,
  parseSearchPeriodDays,
  searchPeriodLabel,
} from './search-period.util';

describe('parseSearchPeriodDays', () => {
  it('returns the default list when unset', () => {
    expect(parseSearchPeriodDays(undefined)).toEqual([...DEFAULT_SEARCH_PERIOD_DAYS]);
  });

  it('returns the default list for an empty/blank string', () => {
    expect(parseSearchPeriodDays('')).toEqual([...DEFAULT_SEARCH_PERIOD_DAYS]);
    expect(parseSearchPeriodDays('   ')).toEqual([...DEFAULT_SEARCH_PERIOD_DAYS]);
  });

  it('parses a valid custom ascending list', () => {
    expect(parseSearchPeriodDays('1,7,30')).toEqual([1, 7, 30]);
  });

  it('trims whitespace around each entry', () => {
    expect(parseSearchPeriodDays(' 1 , 7 , 30 ')).toEqual([1, 7, 30]);
  });

  it('falls back to the default on non-numeric garbage', () => {
    expect(parseSearchPeriodDays('1,abc,30')).toEqual([...DEFAULT_SEARCH_PERIOD_DAYS]);
  });

  it('falls back to the default on a zero or negative entry', () => {
    expect(parseSearchPeriodDays('0,7,30')).toEqual([...DEFAULT_SEARCH_PERIOD_DAYS]);
    expect(parseSearchPeriodDays('-1,7,30')).toEqual([...DEFAULT_SEARCH_PERIOD_DAYS]);
  });

  it('falls back to the default on a non-integer entry', () => {
    expect(parseSearchPeriodDays('1.5,7,30')).toEqual([...DEFAULT_SEARCH_PERIOD_DAYS]);
  });

  it('falls back to the default on duplicate entries', () => {
    expect(parseSearchPeriodDays('1,7,7,30')).toEqual([...DEFAULT_SEARCH_PERIOD_DAYS]);
  });

  it('falls back to the default when entries are not strictly ascending', () => {
    expect(parseSearchPeriodDays('7,1,30')).toEqual([...DEFAULT_SEARCH_PERIOD_DAYS]);
    expect(parseSearchPeriodDays('30,30,1')).toEqual([...DEFAULT_SEARCH_PERIOD_DAYS]);
  });

  it('falls back to the default when an entry exceeds the cap', () => {
    expect(parseSearchPeriodDays(`1,7,${MAX_SEARCH_PERIOD_DAYS + 1}`)).toEqual([...DEFAULT_SEARCH_PERIOD_DAYS]);
  });

  it('accepts an entry exactly at the cap — это и есть «Всё время»', () => {
    expect(parseSearchPeriodDays(`1,${MAX_SEARCH_PERIOD_DAYS}`)).toEqual([1, MAX_SEARCH_PERIOD_DAYS]);
    expect(MAX_SEARCH_PERIOD_DAYS).toBe(ALL_TIME_PERIOD_DAYS);
  });

  it('falls back to the default on a trailing comma (empty entry)', () => {
    expect(parseSearchPeriodDays('1,7,30,')).toEqual([...DEFAULT_SEARCH_PERIOD_DAYS]);
  });
});

describe('searchPeriodLabel', () => {
  it.each([
    [1, 'Сутки'],
    [3, '3 дня'],
    [7, 'Неделя'],
    [14, 'Две недели'],
    [30, 'Месяц'],
    [90, '3 месяца'],
    [180, 'Полгода'],
    [365, 'Год'],
    [730, '2 года'],
    [ALL_TIME_PERIOD_DAYS, 'Всё время'],
  ])('labels %d days as "%s"', (days, expected) => {
    expect(searchPeriodLabel(days)).toBe(expected);
  });

  it('у каждой кнопки по умолчанию есть человеческая подпись, а не «N дн.»', () => {
    for (const days of DEFAULT_SEARCH_PERIOD_DAYS) {
      expect(searchPeriodLabel(days)).not.toMatch(/дн\.$/);
    }
  });

  /**
   * Подпись подставляется в шаблоны «Упоминания за {label}» и «За {label} упоминаний не найдено»
   * (curated-message.util.ts), поэтому сама она не может начинаться с «за» — иначе в сообщении
   * выйдет «Упоминания за За всё время». Именно на этом и был пойман первый вариант подписи.
   */
  it('подпись не начинается с «за» — иначе предлог удвоится в сообщении', () => {
    for (const days of DEFAULT_SEARCH_PERIOD_DAYS) {
      expect(searchPeriodLabel(days)).not.toMatch(/^за\s/i);
    }
  });

  it('falls back to "N дн." for any other value', () => {
    expect(searchPeriodLabel(5)).toBe('5 дн.');
    expect(searchPeriodLabel(1000)).toBe('1000 дн.');
  });
});
