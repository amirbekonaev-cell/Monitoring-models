import { Logger } from '@nestjs/common';

const logger = new Logger('SearchPeriodDays');

export const DEFAULT_SEARCH_PERIOD_DAYS: readonly number[] = [1, 3, 7, 14, 30, 90, 180, 365, 730];
const MAX_SEARCH_PERIOD_DAYS = 3650;

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
  90: '3 месяца',
  180: 'Полгода',
  365: 'Год',
  730: '2 года',
};

/** Russian declension for a period button/heading; any N without a hand-written form falls back to "N дн.". */
export function searchPeriodLabel(days: number): string {
  return PERIOD_LABELS[days] ?? `${days} дн.`;
}
