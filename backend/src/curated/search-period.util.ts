import { Logger } from '@nestjs/common';

const logger = new Logger('SearchPeriodDays');

/**
 * «Всё время» — метка-признак, а не количество дней, которое кто-то считает.
 *
 * CuratedJsonSearchService.dateWindow узнаёт это значение и строит окно
 * [самая старая статья набора .. сегодня]. То есть сами 36500 дней нигде не вычитаются, и период
 * остаётся полным независимо от сегодняшней даты: набор не «вырастет» из окна ни через год, ни
 * через пятьдесят (это закреплено тестом, который прогоняет период с датой «через 50 лет»).
 *
 * Почему число, а не признак вроде `days: 'all'`: период едет через `callback_data`, проверяется
 * через `periodDays.includes(days)` и приходит в `search(period, now)`. Тип периода с тех пор
 * появился — `SearchPeriod` в search-window.util.ts, он понадобился своему отрезку времени, — но
 * число осталось его полноправной формой, и «Всё время» по-прежнему проходит по всем этим местам
 * без единой правки.
 *
 * Почему именно 36500: сортируется последним среди кнопок (список обязан возрастать), очевидно не
 * является настоящим запросом «за N дней» и не столкнётся с периодом, который кто-то реально
 * впишет в SEARCH_PERIOD_DAYS. Вычитание дней для него выполняется только в одном случае — когда
 * в наборе вообще нет дат; тогда величина всё равно ни на что не влияет, находок нет при любом
 * окне.
 */
export const ALL_TIME_PERIOD_DAYS = 36_500;

export const DEFAULT_SEARCH_PERIOD_DAYS: readonly number[] = [
  1,
  3,
  7,
  14,
  30,
  60,
  90,
  180,
  365,
  730,
  ALL_TIME_PERIOD_DAYS,
];

/** Верхняя граница значения в `SEARCH_PERIOD_DAYS`: ровно «за всё время», больше смысла нет. */
export const MAX_SEARCH_PERIOD_DAYS = ALL_TIME_PERIOD_DAYS;

/**
 * Parses `SEARCH_PERIOD_DAYS` ("1,3,7,...") into the list of period buttons /search offers.
 * Falls back to DEFAULT_SEARCH_PERIOD_DAYS (with a warn) on anything malformed — positive
 * integers only, no duplicates, strictly ascending, each ≤ MAX_SEARCH_PERIOD_DAYS. A plain
 * function (not ConfigService-injected) so it can run once at configuration() load time, same as
 * every other env-parsed setting in config/configuration.ts.
 */
export function parseSearchPeriodDays(raw: string | undefined): number[] {
  const fallback = (): number[] => {
    logger.warn(
      `SEARCH_PERIOD_DAYS="${raw ?? ''}" некорректен (нужны целые положительные числа ≤${MAX_SEARCH_PERIOD_DAYS}, ` +
        `без повторов, строго по возрастанию, через запятую) — используется значение по умолчанию: ` +
        DEFAULT_SEARCH_PERIOD_DAYS.join(','),
    );
    return [...DEFAULT_SEARCH_PERIOD_DAYS];
  };

  if (!raw || !raw.trim()) {
    return [...DEFAULT_SEARCH_PERIOD_DAYS];
  }

  const parts = raw.split(',').map((p) => p.trim());
  if (parts.some((p) => p.length === 0)) {
    return fallback();
  }

  const numbers = parts.map(Number);
  const allValidIntegers = numbers.every((n) => Number.isInteger(n) && n > 0 && n <= MAX_SEARCH_PERIOD_DAYS);
  if (!allValidIntegers) {
    return fallback();
  }

  const allUnique = new Set(numbers).size === numbers.length;
  if (!allUnique) {
    return fallback();
  }

  const strictlyAscending = numbers.every((n, i) => i === 0 || numbers[i - 1] < n);
  if (!strictlyAscending) {
    return fallback();
  }

  return numbers;
}

const PERIOD_LABELS: Record<number, string> = {
  1: 'Сутки',
  3: '3 дня',
  7: 'Неделя',
  14: 'Две недели',
  30: 'Месяц',
  60: '2 месяца',
  90: '3 месяца',
  180: 'Полгода',
  365: 'Год',
  730: '2 года',
  [ALL_TIME_PERIOD_DAYS]: 'Всё время',
};

/** Russian declension for a period button/heading; any N without a hand-written form falls back to "N дн.". */
export function searchPeriodLabel(days: number): string {
  return PERIOD_LABELS[days] ?? `${days} дн.`;
}
