/**
 * Parses a publish date written for humans ("20 января 2023", "22 қыркүйек 2026", "28.10.2024")
 * out of a fragment of page text.
 *
 * Needed because a large share of the Kazakh news sites this project reads publish no machine-
 * readable date at all — no `article:published_time`, no JSON-LD, no `<time datetime>` — and
 * print the date only as prose next to the headline. Verified live across the closed pool:
 * sknews.kz, profit.kz, infozakon.kz and rail-news.kz between them account for 81 of ~169 pool
 * links and every one of them is in that category. Without this, those articles carry no date,
 * and an article with no date can never appear in a /search period window.
 *
 * Pure and dependency-free so it can be unit-tested against the exact strings those sites emit.
 */

/** Russian month names in the genitive form dates are written in ("20 января"). */
const RU_MONTHS = [
  'январ',
  'феврал',
  'март',
  'апрел',
  'ма[йя]',
  'июн',
  'июл',
  'август',
  'сентябр',
  'октябр',
  'ноябр',
  'декабр',
];

/** Kazakh month names. Matched on a stem so declined forms ("қыркүйегінде") still parse. */
const KK_MONTHS = [
  'қаңтар',
  'ақпан',
  'наурыз',
  'сәуір',
  'мамыр',
  'маусым',
  'шілде',
  'тамыз',
  'қыркүйек|қыркүйег',
  'қазан',
  'қараша',
  'желтоқсан',
];

function monthPattern(months: string[]): RegExp {
  return new RegExp(`(\\d{1,2})\\s+(${months.map((m, i) => `(?<m${i}>${m})`).join('|')})[а-яёәғқңөұүһі]*\\s+(\\d{4})`, 'iu');
}

const RU_PATTERN = monthPattern(RU_MONTHS);
const KK_PATTERN = monthPattern(KK_MONTHS);
/** 28.10.2024 / 17-12-2024 / 17/12/2024 */
const NUMERIC_DMY = /(?<![0-9])(\d{1,2})[.\-/](\d{1,2})[.\-/]((?:19|20)\d{2})(?![0-9])/;
/** 2024-12-17 */
const NUMERIC_YMD = /(?<![0-9])((?:19|20)\d{2})-(\d{1,2})-(\d{1,2})(?![0-9])/;

function utcDate(year: number, month: number, day: number): Date | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return null;
  }
  const date = new Date(Date.UTC(year, month - 1, day));
  // Rejects an overflowed date (31 февраля would otherwise become March 3rd).
  return date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? date : null;
}

function matchNamedMonth(text: string, pattern: RegExp, monthCount: number): Date | null {
  const match = text.match(pattern);
  if (!match?.groups) {
    return null;
  }
  for (let i = 0; i < monthCount; i += 1) {
    if (match.groups[`m${i}`] !== undefined) {
      return utcDate(Number(match[match.length - 1]), i + 1, Number(match[1]));
    }
  }
  return null;
}

/**
 * The first date found in `text`, or null. Formats are tried most-specific first: a written-out
 * month name is unambiguous, whereas a numeric `17-12-2024` has to be assumed day-first (which
 * is how every site in this pool writes it — Kazakh sites do not use the American order).
 */
export function parseHumanReadableDate(text: string): Date | null {
  if (!text || !text.trim()) {
    return null;
  }
  const haystack = text.replace(/\s+/g, ' ');

  const ru = matchNamedMonth(haystack, RU_PATTERN, RU_MONTHS.length);
  if (ru) return ru;

  const kk = matchNamedMonth(haystack, KK_PATTERN, KK_MONTHS.length);
  if (kk) return kk;

  const ymd = haystack.match(NUMERIC_YMD);
  if (ymd) {
    const parsed = utcDate(Number(ymd[1]), Number(ymd[2]), Number(ymd[3]));
    if (parsed) return parsed;
  }

  const dmy = haystack.match(NUMERIC_DMY);
  if (dmy) {
    const parsed = utcDate(Number(dmy[3]), Number(dmy[2]), Number(dmy[1]));
    if (parsed) return parsed;
  }

  return null;
}

/**
 * The date of `text`, but ONLY when the text is unambiguous about it: every date found anywhere
 * in it must be the same calendar day. Returns null the moment two different dates appear.
 *
 * This is the safe way to fall back to scanning a whole page after a headline-scoped search has
 * found nothing (see ParserService.extractArticlePublishedAt). Scanning a whole page normally
 * risks picking up a "latest news" sidebar's dates — today's — and stamping a five-year-old
 * article with them, which for the closed pool is the worst possible error: the article would
 * then match every /search period forever. Requiring agreement removes that risk entirely; a
 * page with a sidebar has many dates and simply yields null, while a page whose only date is its
 * own (observed on sk.kz, whose article date sits outside the headline's subtree) resolves.
 */
export function findUnambiguousDate(text: string): Date | null {
  if (!text || !text.trim()) {
    return null;
  }
  const haystack = text.replace(/\s+/g, ' ');

  const found = new Set<number>();
  // Walk the text, consuming it one match at a time, so every date is seen — not just the first.
  let cursor = 0;
  for (let guard = 0; guard < 200 && cursor < haystack.length; guard += 1) {
    const rest = haystack.slice(cursor);
    const date = parseHumanReadableDate(rest);
    if (!date) {
      break;
    }
    found.add(date.getTime());
    if (found.size > 1) {
      return null;
    }
    // Advance past this match. parseHumanReadableDate does not report an offset, so step forward
    // by the shortest possible date length to guarantee progress without skipping a neighbour.
    cursor += Math.max(1, indexAfterFirstDate(rest));
  }

  return found.size === 1 ? new Date([...found][0]) : null;
}

/** Character offset just past the first date-looking run in `text` (best effort, always > 0). */
function indexAfterFirstDate(text: string): number {
  const match = text.match(/(\d{1,2}\s+[^\s]{3,12}\s+\d{4})|(\d{1,2}[.\-/]\d{1,2}[.\-/]\d{4})|((?:19|20)\d{2}-\d{1,2}-\d{1,2})/u);
  return match?.index !== undefined ? match.index + match[0].length : 1;
}
