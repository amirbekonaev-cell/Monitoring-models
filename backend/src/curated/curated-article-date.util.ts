/**
 * Publish-date resolution for a closed-pool link. The bot's whole /search feature is "показать
 * упоминания за период", so a wrong date is worse than no date: a mention dated "today" because
 * nothing better was found would show up in every single period window, permanently. Hence two
 * hard rules enforced here:
 *
 *  1. **The current date is never a fallback.** When no source yields a date, the answer is
 *     `null` (and the mention is counted separately as "без даты" — see CuratedSearchService).
 *  2. **Every candidate is plausibility-checked** before it is accepted (see isPlausibleArticleDate):
 *     anything before 2000-01-01 or after tomorrow is treated as "not a date I read correctly"
 *     and the next source in the chain is tried instead. This is what keeps an article id that
 *     happens to look like a date (sputnik.kz's `...-65434810.html` → "year 6543") from being
 *     written into published_at.
 *
 * The source that actually won is recorded in `curated_links.date_source` so a human can tell a
 * metadata date from one merely guessed out of the URL.
 */

export type ArticleDateSource = 'page' | 'url' | 'model';

export interface ResolvedArticleDate {
  date: Date | null;
  source: ArticleDateSource | null;
}

/** Lower bound: the pool is Kazakh tech/business media, none of which predates this. */
const MIN_PLAUSIBLE = Date.UTC(2000, 0, 1);

/**
 * A date is plausible when it lands in [2000-01-01, tomorrow]. "Tomorrow" rather than "now"
 * because a publisher in a +05/+06 timezone can legitimately stamp an article with a calendar
 * date that is still in the future in UTC.
 */
export function isPlausibleArticleDate(date: Date | null | undefined, now: Date = new Date()): boolean {
  if (!date || Number.isNaN(date.getTime())) {
    return false;
  }
  const tomorrow = now.getTime() + 24 * 60 * 60 * 1000;
  return date.getTime() >= MIN_PLAUSIBLE && date.getTime() <= tomorrow;
}

/** YYYY-MM-DD / YYYY/MM/DD (kursiv.media `/2026-04-20/`, bizmedia `/2026-04-21-slug`). */
const YMD = /(?<![0-9])((?:19|20)[0-9]{2})[-/.]([0-1]?[0-9])[-/.]([0-3]?[0-9])(?![0-9])/;
/** DD-MM-YYYY (kyzylorda-news.kz `...-22-05-2026`) — the mirror image, told apart by which end
 *  carries the 4-digit year. */
const DMY = /(?<![0-9])([0-3]?[0-9])[-/.]([0-1]?[0-9])[-/.]((?:19|20)[0-9]{2})(?![0-9])/;
/** YYYY/MM with no day (`/2023/08/slug`) — day 1 is assumed, which is accurate to the month. */
const YM = /(?<![0-9])((?:19|20)[0-9]{2})[-/.]([0-1][0-9])(?![0-9])/;
/** A whole path segment of exactly 8 digits (ru.sputnik.kz `/20260803/`). Deliberately anchored
 *  to a complete segment: plenty of URLs carry 8-digit article ids inside a longer slug, and the
 *  plausibility check below rejects those that slip through anyway. */
const YMD_COMPACT = /^([0-9]{4})([0-1][0-9])([0-3][0-9])$/;

function utcDate(year: number, month: number, day: number): Date | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return null;
  }
  const date = new Date(Date.UTC(year, month - 1, day));
  // Rejects overflowed dates (2023-02-31 would silently become March 3rd otherwise).
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return null;
  }
  return date;
}

/**
 * Best-effort publish date read out of the URL itself — path and query only, never the host
 * (a hostname digit run is never a date). Returns the first plausible candidate; an
 * implausible match (an article id shaped like a date) is skipped rather than returned.
 */
export function extractDateFromUrl(rawUrl: string, now: Date = new Date()): Date | null {
  let target: string;
  try {
    const parsed = new URL(rawUrl);
    target = `${parsed.pathname}${parsed.search}`;
  } catch {
    return null;
  }

  const candidates: Array<Date | null> = [];

  for (const segment of target.split('/')) {
    const compact = segment.match(YMD_COMPACT);
    if (compact) {
      candidates.push(utcDate(Number(compact[1]), Number(compact[2]), Number(compact[3])));
    }
  }

  const ymd = target.match(YMD);
  if (ymd) {
    candidates.push(utcDate(Number(ymd[1]), Number(ymd[2]), Number(ymd[3])));
  }

  const dmy = target.match(DMY);
  if (dmy) {
    candidates.push(utcDate(Number(dmy[3]), Number(dmy[2]), Number(dmy[1])));
  }

  const ym = target.match(YM);
  if (ym) {
    candidates.push(utcDate(Number(ym[1]), Number(ym[2]), 1));
  }

  for (const candidate of candidates) {
    if (isPlausibleArticleDate(candidate, now)) {
      return candidate;
    }
  }
  return null;
}

/** Parses an ISO-ish date string (what the model returns, and what page metadata carries). */
export function parseIsoDate(value: string | null | undefined): Date | null {
  if (!value || !value.trim()) {
    return null;
  }
  const date = new Date(value.trim());
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * The date-source chain, in priority order: page metadata -> the URL -> the model's answer ->
 * nothing. Each candidate must pass isPlausibleArticleDate() to be taken; an implausible one
 * falls through to the next source rather than aborting the chain.
 */
export function resolveArticleDate(
  candidates: { fromPage?: Date | null; fromUrl?: Date | null; fromModel?: Date | null },
  now: Date = new Date(),
): ResolvedArticleDate {
  const ordered: Array<[ArticleDateSource, Date | null | undefined]> = [
    ['page', candidates.fromPage],
    ['url', candidates.fromUrl],
    ['model', candidates.fromModel],
  ];

  for (const [source, date] of ordered) {
    if (isPlausibleArticleDate(date, now)) {
      return { date: date as Date, source };
    }
  }

  return { date: null, source: null };
}
