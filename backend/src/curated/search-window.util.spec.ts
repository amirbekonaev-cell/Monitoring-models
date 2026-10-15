import {
  decodeSearchPeriod,
  encodeSearchPeriod,
  parseSearchRangeInput,
  RangeError,
  ParsedRange,
  searchWindowLabel,
  searchWindowSpanDays,
  toSearchWindow,
} from './search-window.util';
import { ALL_TIME_PERIOD_DAYS } from './search-period.util';

const TZ = 'Asia/Almaty';
const NOW = new Date('2026-10-15T09:00:00Z');

function parse(raw: string): ParsedRange | RangeError {
  return parseSearchRangeInput(raw, NOW, TZ);
}

function window(raw: string) {
  const result = parse(raw);
  if ('error' in result) {
    throw new Error(`ожидался разбор, получена ошибка: ${result.error}`);
  }
  return result.window;
}

function error(raw: string): string {
  const result = parse(raw);
  if (!('error' in result)) {
    throw new Error(`ожидалась ошибка, получено окно ${JSON.stringify(result.window)}`);
  }
  return result.error;
}

/**
 * Свой отрезок времени, вписанный руками. Человек печатает его в чате, поэтому разбор обязан
 * принимать то, как даты пишут в жизни, и отказывать внятным текстом, а не падать.
 */
describe('parseSearchRangeInput', () => {
  it('принимает привычный порядок ДД.ММ.ГГГГ', () => {
    expect(window('01.07.2026-15.10.2026')).toEqual({
      kind: 'range',
      dateFrom: '2026-07-01',
      dateTo: '2026-10-15',
    });
  });

  it('принимает порядок ГГГГ-ММ-ДД', () => {
    expect(window('2026-07-01 2026-10-15')).toEqual({
      kind: 'range',
      dateFrom: '2026-07-01',
      dateTo: '2026-10-15',
    });
  });

  /** Что стоит между датами, значения не имеет: разбор достаёт сами даты. */
  it.each(['01.07.2026-15.10.2026', '01.07.2026 - 15.10.2026', '01.07.2026 — 15.10.2026', '01.07.2026..15.10.2026', '01.07.2026 15.10.2026', '  01.07.2026   —   15.10.2026  '])(
    'принимает разделитель в «%s»',
    (raw) => {
      expect(window(raw)).toEqual({ kind: 'range', dateFrom: '2026-07-01', dateTo: '2026-10-15' });
    },
  );

  it('принимает даты без ведущих нулей', () => {
    expect(window('1.7.2026-5.9.2026')).toEqual({
      kind: 'range',
      dateFrom: '2026-07-01',
      dateTo: '2026-09-05',
    });
  });

  /** Одна дата — «с неё по сегодня»: человек спрашивает, что было с тех пор. */
  it('одна дата даёт отрезок до сегодняшнего дня', () => {
    expect(window('01.07.2026')).toEqual({ kind: 'range', dateFrom: '2026-07-01', dateTo: '2026-10-15' });
  });

  it('один день целиком задаётся повтором даты', () => {
    expect(window('01.07.2026-01.07.2026')).toEqual({
      kind: 'range',
      dateFrom: '2026-07-01',
      dateTo: '2026-07-01',
    });
  });

  it('сегодняшний день берётся в часовом поясе выдачи, а не в UTC', () => {
    // 2026-10-15T20:00Z — это уже 16 октября в Алматы (UTC+5).
    const result = parseSearchRangeInput('01.07.2026', new Date('2026-10-15T20:00:00Z'), TZ);
    expect((result as ParsedRange).window.dateTo).toBe('2026-10-16');
  });

  it('даты из будущего принимаются как есть — это ответ на заданный вопрос, а не ошибка', () => {
    expect(window('01.01.2027-31.12.2027')).toEqual({
      kind: 'range',
      dateFrom: '2027-01-01',
      dateTo: '2027-12-31',
    });
  });

  describe('неудачный ввод', () => {
    it('пусто', () => {
      expect(error('   ')).toContain('Не вижу дат');
    });

    it('не даты вовсе', () => {
      expect(error('с июля по октябрь')).toContain('Не понял даты');
      expect(error('вчера-сегодня')).toContain('Не понял даты');
    });

    it('такого дня нет в календаре', () => {
      expect(error('32.07.2026-15.10.2026')).toContain('Не понял даты');
      expect(error('30.02.2026')).toContain('Не понял даты');
      expect(error('2026-13-01')).toContain('Не понял даты');
    });

    /** 2024 — год високосный, 29 февраля в нём есть. */
    it('29 февраля високосного года — это дата', () => {
      expect(window('29.02.2024-01.03.2024')).toEqual({
        kind: 'range',
        dateFrom: '2024-02-29',
        dateTo: '2024-03-01',
      });
    });

    /** Конец отрезка бот подставил сам, поэтому и объяснять надо это, а не «поменяйте местами». */
    it('одна дата из будущего — отдельное объяснение', () => {
      const message = error('01.01.2027');
      expect(message).toContain('это будущее');
      expect(message).toContain('15.10.2026');
      expect(message).not.toContain('Поменяйте даты местами');
    });

    it('начало позже конца', () => {
      const message = error('15.10.2026-01.07.2026');
      expect(message).toContain('позже конца');
      expect(message).toContain('15.10.2026');
    });

    it('дат больше двух', () => {
      expect(error('01.07.2026 15.08.2026 15.10.2026')).toContain('не больше двух');
    });

    it('двузначный год не принимается — он читался бы двояко', () => {
      expect(error('01.07.26-15.10.26')).toContain('Не понял даты');
    });
  });
});

describe('период в callback_data', () => {
  it('число дней переживает запись и чтение', () => {
    expect(decodeSearchPeriod(encodeSearchPeriod(7))).toEqual({ kind: 'days', days: 7 });
    expect(decodeSearchPeriod(encodeSearchPeriod(ALL_TIME_PERIOD_DAYS))).toEqual({
      kind: 'days',
      days: ALL_TIME_PERIOD_DAYS,
    });
  });

  it('свой отрезок переживает запись и чтение', () => {
    const range = { kind: 'range' as const, dateFrom: '2026-07-01', dateTo: '2026-10-15' };
    expect(encodeSearchPeriod(range)).toBe('2026-07-01~2026-10-15');
    expect(decodeSearchPeriod('2026-07-01~2026-10-15')).toEqual(range);
  });

  /** Telegram рубит callback_data на 64 байтах — предельный случай обязан влезать с запасом. */
  it('самая длинная кнопка влезает в лимит Telegram', () => {
    const data = `search_each:${encodeSearchPeriod({ kind: 'range', dateFrom: '2026-07-01', dateTo: '2026-10-15' })}:168`;
    expect(Buffer.byteLength(data, 'utf8')).toBeLessThanOrEqual(64);
  });

  it('подделанное или незнакомое значение — null, а не поиск наугад', () => {
    expect(decodeSearchPeriod('')).toBeNull();
    expect(decodeSearchPeriod('0')).toBeNull();
    expect(decodeSearchPeriod('999999')).toBeNull();
    expect(decodeSearchPeriod('вчера')).toBeNull();
    expect(decodeSearchPeriod('2026-07-01')).toBeNull();
    expect(decodeSearchPeriod('2026-07-01~32.10.2026')).toBeNull();
    expect(decodeSearchPeriod('2026-10-15~2026-07-01')).toBeNull();
    expect(decodeSearchPeriod('2026-07-01~2026-10-15~2026-11-01')).toBeNull();
  });
});

describe('подпись и длина окна', () => {
  it('у кнопки — её название, у отрезка — сами даты', () => {
    expect(searchWindowLabel(7)).toBe('Неделя');
    expect(searchWindowLabel(ALL_TIME_PERIOD_DAYS)).toBe('Всё время');
    expect(searchWindowLabel({ kind: 'range', dateFrom: '2026-07-01', dateTo: '2026-10-15' })).toBe(
      '01.07.2026 — 15.10.2026',
    );
  });

  it('длина отрезка считается по границам включительно', () => {
    expect(searchWindowSpanDays({ kind: 'range', dateFrom: '2026-07-01', dateTo: '2026-07-01' })).toBe(1);
    expect(searchWindowSpanDays({ kind: 'range', dateFrom: '2026-07-01', dateTo: '2026-07-31' })).toBe(31);
    expect(searchWindowSpanDays(toSearchWindow(7))).toBe(7);
  });
});
