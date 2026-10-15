import { formatIsoDateDisplay, zonedDateString } from './curated-date.util';
import { ALL_TIME_PERIOD_DAYS, searchPeriodLabel } from './search-period.util';

/** Окно «за последние N дней» — то, что задают кнопки периода. */
export interface DaysWindow {
  kind: 'days';
  days: number;
}

/** Свой отрезок: обе границы заданы человеком, включительно, календарные даты «ГГГГ-ММ-ДД». */
export interface RangeWindow {
  kind: 'range';
  dateFrom: string;
  dateTo: string;
}

export type SearchWindow = DaysWindow | RangeWindow;

/**
 * Период поиска: либо число дней (как было всегда), либо окно.
 *
 * Число оставлено полноправной формой намеренно — им пользуются все прежние вызовы (кнопки
 * периода, скрипты, публикация в дашборд), и переписывать их ради своего отрезка не нужно.
 */
export type SearchPeriod = number | SearchWindow;

const MS_PER_DAY = 86_400_000;

/** Приводит период к окну: число — это «за N дней». */
export function toSearchWindow(period: SearchPeriod): SearchWindow {
  return typeof period === 'number' ? { kind: 'days', days: period } : period;
}

export function isRangeWindow(period: SearchPeriod): boolean {
  return typeof period !== 'number' && period.kind === 'range';
}

/**
 * Сколько дней в окне — для поля `periodDays` в выдаче и для логов.
 *
 * У своего отрезка это его длина (границы включительно), а не «дней назад»: сравнивать её с
 * ALL_TIME_PERIOD_DAYS или вычитать из сегодняшней даты нельзя — у отрезка своя правая граница.
 */
export function searchWindowSpanDays(window: SearchWindow): number {
  if (window.kind === 'days') {
    return window.days;
  }
  const from = Date.parse(`${window.dateFrom}T00:00:00Z`);
  const to = Date.parse(`${window.dateTo}T00:00:00Z`);
  return Math.round((to - from) / MS_PER_DAY) + 1;
}

/** Подпись периода в сообщении: у кнопок — их название, у своего отрезка — сами даты. */
export function searchWindowLabel(period: SearchPeriod): string {
  const window = toSearchWindow(period);
  return window.kind === 'days'
    ? searchPeriodLabel(window.days)
    : `${formatIsoDateDisplay(window.dateFrom)} — ${formatIsoDateDisplay(window.dateTo)}`;
}

/**
 * Период в `callback_data` и в ключе хранилища находок.
 *
 * Разделитель внутри отрезка — `~`, а не `:`: двоеточием разделены САМИ поля callback_data
 * (`search_each:<период>:<смещение>`), и дата с двоеточиями разъехалась бы по полям. Длина
 * предельного случая — `search_each:2026-07-01~2026-10-15:16`, 36 байт из 64 разрешённых
 * Telegram.
 */
export function encodeSearchPeriod(period: SearchPeriod): string {
  const window = toSearchWindow(period);
  return window.kind === 'days' ? String(window.days) : `${window.dateFrom}~${window.dateTo}`;
}

/**
 * Разбор периода из `callback_data`. `null` — значение, которого бот не выдавал: кнопка из
 * будущего или подделанная, и обработчик обязан отказать, а не искать за что-нибудь наугад.
 */
export function decodeSearchPeriod(raw: string): SearchWindow | null {
  if (/^\d+$/.test(raw)) {
    const days = Number(raw);
    return days > 0 && days <= ALL_TIME_PERIOD_DAYS ? { kind: 'days', days } : null;
  }

  const parts = raw.split('~');
  if (parts.length !== 2) {
    return null;
  }
  const [dateFrom, dateTo] = parts;
  if (!isCalendarDate(dateFrom) || !isCalendarDate(dateTo) || dateFrom > dateTo) {
    return null;
  }
  return { kind: 'range', dateFrom, dateTo };
}

export interface ParsedRange {
  window: RangeWindow;
}

export interface RangeError {
  error: string;
}

/**
 * Разбор своего отрезка, вписанного человеком: `/search 01.07.2026-15.10.2026` или ответ на
 * вопрос бота о датах.
 *
 * Принимаются оба привычных порядка записи — `01.07.2026` и `2026-07-01`, — и любой из
 * разделителей: дефис, тире, две точки, просто пробел. Одна дата означает «с неё по сегодня»:
 * человек, вписавший один день, спрашивает «что было с тех пор», а не «что было ровно в тот
 * день» — и об этом прямо сказано в подсказке бота.
 *
 * Ошибка — это текст для чата, а не исключение: человек вписал даты руками, и ему нужно сказать,
 * что именно не так, а не «произошла ошибка».
 */
export function parseSearchRangeInput(raw: string, now: Date, timezone: string): ParsedRange | RangeError {
  const cleaned = (raw ?? '').trim();
  if (!cleaned) {
    return { error: 'Не вижу дат. Пример: 01.07.2026-15.10.2026' };
  }

  // Даты вынимаются прямо из строки, а не делением по разделителю: разделитель отрезка — тот же
  // символ, что и внутри самих дат («01.07.2026-15.10.2026»), и деление по нему рассыпало бы их
  // на куски. Поэтому «любой разделитель» здесь получается сам собой: что стоит между датами,
  // значения не имеет.
  const dates = extractDates(cleaned);
  if (dates === null) {
    return {
      error:
        `Не понял даты: «${cleaned}». Нужны одна или две даты в виде 01.07.2026 или 2026-07-01, ` +
        'например: 01.07.2026-15.10.2026',
    };
  }
  if (dates.length > 2) {
    return { error: 'Дат должно быть не больше двух: начало и конец отрезка.' };
  }

  const today = zonedDateString(now, timezone);
  const dateFrom = dates[0];
  const dateTo = dates.length === 2 ? dates[1] : today;

  if (dateFrom > dateTo) {
    // Одна дата из будущего — отдельный случай: конец отрезка бот подставил сам (сегодня), и
    // «поменяйте даты местами» звучало бы как претензия к тому, чего человек не писал.
    if (dates.length === 1) {
      return {
        error:
          `${formatIsoDateDisplay(dateFrom)} — это будущее, а отрезок с одной датой идёт по ` +
          `сегодня (${formatIsoDateDisplay(dateTo)}). Укажите вторую дату или возьмите дату в прошлом.`,
      };
    }
    return {
      error:
        `Начало отрезка позже конца: с ${formatIsoDateDisplay(dateFrom)} по ` +
        `${formatIsoDateDisplay(dateTo)}. Поменяйте даты местами.`,
    };
  }

  return { window: { kind: 'range', dateFrom, dateTo } };
}

/**
 * Находит в строке одну или две календарные даты в любом из двух порядков записи.
 *
 * `null` — если встретилось что-то, что на дату похоже, но ею не является: «32.07.2026»,
 * «2026-13-01», «вчера». Проверка именно календарная (через Date), поэтому 30 февраля не
 * проходит, а 29.02.2028 проходит.
 */
function extractDates(input: string): string[] | null {
  const matches = input.match(/\d{1,4}[.\-/]\d{1,2}[.\-/]\d{1,4}/g);
  if (!matches || matches.length === 0) {
    return null;
  }

  const dates: string[] = [];
  for (const match of matches) {
    const iso = toIsoDate(match);
    if (iso === null) {
      return null;
    }
    dates.push(iso);
  }
  return dates;
}

/** «01.07.2026» или «2026-07-01» → «2026-07-01»; `null`, если такой даты в календаре нет. */
function toIsoDate(raw: string): string | null {
  const parts = raw.split(/[.\-/]/);
  if (parts.length !== 3) {
    return null;
  }

  const [a, b, c] = parts;
  // Год впереди — значит порядок ГГГГ-ММ-ДД; иначе ДД.ММ.ГГГГ.
  const [year, month, day] = a.length === 4 ? [a, b, c] : [c, b, a];
  if (year.length !== 4) {
    return null;
  }

  const iso = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  return isCalendarDate(iso) ? iso : null;
}

/** Строка «ГГГГ-ММ-ДД», которая существует в календаре (31 апреля не существует). */
function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
