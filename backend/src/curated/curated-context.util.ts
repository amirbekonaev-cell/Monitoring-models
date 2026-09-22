/**
 * Builds the text that becomes `mention.text` AND the input the sentiment classifier sees.
 *
 * Why this exists rather than "just pass the article": SentimentAnalysisService truncates its
 * input at 6000 characters. A pool article is frequently a long industry round-up in which the
 * company is named once, in the middle — the first 6000 characters of such a piece can easily
 * not contain the company at all, and the classifier then dutifully rates the tone of *the
 * article*, which is not what /search reports. Cutting the article down to the neighbourhoods
 * of the actual mentions makes the classifier see the mention every time, and makes the snippet
 * shown to a human the relevant passage instead of the lede.
 *
 * A pure function on purpose (no DB, no network, no config): it's the piece most worth pinning
 * down with tests.
 */

export const CONTEXT_WINDOW_CHARS = 600;
export const CONTEXT_MAX_CHARS = 4000;

export interface BuildContextOptions {
  /** Characters of context kept on each side of an occurrence. */
  windowChars?: number;
  /** Hard cap on the returned string (title included). */
  maxChars?: number;
}

interface Range {
  start: number;
  end: number;
}

/**
 * Locates every case-insensitive occurrence of any term, merges the ±window ranges that touch or
 * overlap (so two mentions one sentence apart produce one passage, not two overlapping copies of
 * it), and joins the passages with " … ". The title is always prepended.
 *
 * With no occurrence in the body at all (the term matched only the title, or matched via
 * Postgres FTS stemming rather than as a literal substring), the leading `maxChars` of the body
 * are returned — the caller has already decided the article IS relevant; this function's job is
 * only to choose the best excerpt, never to veto.
 */
export function buildMentionContext(
  title: string,
  body: string,
  terms: string[],
  options: BuildContextOptions = {},
): string {
  const windowChars = options.windowChars ?? CONTEXT_WINDOW_CHARS;
  const maxChars = options.maxChars ?? CONTEXT_MAX_CHARS;

  const cleanTitle = (title ?? '').trim();
  const cleanBody = (body ?? '').replace(/\s+/g, ' ').trim();

  if (!cleanBody) {
    return cleanTitle.slice(0, maxChars);
  }

  const ranges = mergeRanges(findOccurrenceRanges(cleanBody, terms, windowChars));

  const excerpt =
    ranges.length > 0
      ? ranges.map((range) => cleanBody.slice(range.start, range.end).trim()).join(' … ')
      : cleanBody;

  const composed = cleanTitle ? `${cleanTitle}\n\n${excerpt}` : excerpt;
  return composed.length <= maxChars ? composed : `${composed.slice(0, maxChars).trimEnd()}…`;
}

function findOccurrenceRanges(body: string, terms: string[], windowChars: number): Range[] {
  const haystack = body.toLowerCase();
  const ranges: Range[] = [];

  for (const rawTerm of terms) {
    const term = (rawTerm ?? '').trim().toLowerCase();
    if (!term) {
      continue;
    }
    let from = 0;
    for (;;) {
      const index = haystack.indexOf(term, from);
      if (index === -1) {
        break;
      }
      ranges.push({
        start: Math.max(0, index - windowChars),
        end: Math.min(body.length, index + term.length + windowChars),
      });
      from = index + term.length;
    }
  }

  return ranges;
}

function mergeRanges(ranges: Range[]): Range[] {
  if (ranges.length === 0) {
    return [];
  }
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const merged: Range[] = [sorted[0]];
  for (const range of sorted.slice(1)) {
    const last = merged[merged.length - 1];
    if (range.start <= last.end) {
      last.end = Math.max(last.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}
