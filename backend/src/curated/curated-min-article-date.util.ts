import { Logger } from '@nestjs/common';

const logger = new Logger('CuratedMinArticleDate');

/**
 * Parses `CURATED_MIN_ARTICLE_DATE` — the optional "articles older than this are not worth a
 * mention" cutoff applied by CuratedIngestService.processLink.
 *
 * Empty/unset means **no cutoff at all** (the previous behaviour, and the default): the pool is
 * hand-vetted, so dropping old links is an explicit editorial decision, never something that
 * happens because a variable was forgotten.
 *
 * Accepts a plain calendar date, `YYYY-MM-DD`, and nothing else. Anything malformed is **ignored
 * with a warn** rather than throwing: this runs at configuration() load time, and a typo in one
 * optional filter must not stop the whole backend (and, on Vercel, every cold start) from booting.
 * A rejected value therefore behaves exactly like an unset one — no cutoff.
 *
 * The result is midnight UTC of that calendar day, and the comparison in processLink is `<`, so a
 * link published *on* the threshold day is kept. Dates are compared as timestamps against
 * `published_at`, which the pool resolves to a date-only value in UTC for every source
 * (curated-article-date.util.ts) — so there is no timezone skew to correct for here.
 */
export function parseCuratedMinArticleDate(raw: string | undefined): Date | null {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return null;
  }

  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (!match) {
    logger.warn(
      `CURATED_MIN_ARTICLE_DATE="${trimmed}" не похож на дату в формате YYYY-MM-DD — отсечка по дате ` +
        'статьи отключена (ссылки обрабатываются без ограничения по возрасту статьи).',
    );
    return null;
  }

  const [, year, month, day] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  // Rejects both nonsense months/days and silent overflow (2023-02-31 would otherwise become
  // March 3rd — a date the operator never wrote).
  if (
    date.getUTCFullYear() !== Number(year) ||
    date.getUTCMonth() !== Number(month) - 1 ||
    date.getUTCDate() !== Number(day)
  ) {
    logger.warn(
      `CURATED_MIN_ARTICLE_DATE="${trimmed}" — такой календарной даты не существует, отсечка по дате ` +
        'статьи отключена.',
    );
    return null;
  }

  return date;
}

/** `last_error` text for a link rejected by the cutoff — no URL, same style as the other reasons. */
export function minArticleDateRejectionReason(articleDate: Date, threshold: Date): string {
  return (
    `статья старше порога CURATED_MIN_ARTICLE_DATE: дата статьи ${isoDay(articleDate)}, ` +
    `порог ${isoDay(threshold)}`
  );
}

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}
