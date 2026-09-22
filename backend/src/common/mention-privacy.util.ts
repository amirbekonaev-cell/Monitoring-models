/**
 * Server-side redaction of hidden mention URLs. This project has NO authentication: every REST
 * endpoint is reachable by anyone who knows the deployment URL. So "не показывать ссылки пула"
 * cannot be a frontend concern (CSS, conditional rendering, a filtered column in one component) —
 * anything the API serializes is public, and a link that is merely hidden in the UI is one
 * `curl /mentions` away from being read. The redaction therefore happens here, on the way out,
 * to the JSON itself.
 *
 * `urlHidden` is the authority, not `curatedLinkId`: deleting a curated_links row sets
 * `curated_link_id` to NULL (ON DELETE SET NULL) and must never resurrect the URL.
 *
 * Applied centrally by MentionPrivacyInterceptor (registered globally, see AppModule) rather
 * than per-controller, so a new endpoint that returns mentions is covered the day it is written
 * instead of the day someone remembers to redact in it.
 */

/** The fields that carry a URL and therefore must not leave the server for a hidden mention. */
const REDACTED_FIELDS = ['url', 'reprints'] as const;

/**
 * Dropping `url` is not sufficient on its own: a news page often prints its own address inside
 * the article body (a "copy link" block, a share widget), so the extracted `text` — and any
 * `summary` written from it — can carry the very link `url` withheld. Observed live on
 * kz.kursiv.media. The ingestion strips links before storing (see curated-context.util.ts), and
 * this scrubs them again on the way out so rows written before that fix, or by any other path,
 * are covered too.
 */
const SCRUBBED_TEXT_FIELDS = ['text', 'summary', 'title'] as const;
const URL_IN_TEXT = /https?:\/\/\S+/gi;
const URL_PLACEHOLDER = '[ссылка]';

/** Guards against pathological/cyclic payloads — no real API response nests this deep. */
const MAX_DEPTH = 8;

export function shouldExposeCuratedUrls(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CURATED_LINKS_EXPOSE_URLS === 'true';
}

function isHiddenMention(value: Record<string, unknown>): boolean {
  return value.urlHidden === true || value.url_hidden === true;
}

/**
 * Returns `value` with `url`/`reprints` removed from every hidden-mention-shaped object inside
 * it, at any nesting depth (a bare mention, `{ items: [...] }`, a mention nested in a wrapper —
 * all covered by the same walk). Non-hidden objects are passed through untouched, and the input
 * is never mutated: a redacted copy is built only for the branches that actually contain a
 * hidden mention, so the common case (no pool mentions in the response) allocates nothing.
 */
export function redactHiddenMentions<T>(value: T, depth = 0): T {
  if (depth > MAX_DEPTH || value === null || typeof value !== 'object') {
    return value;
  }

  if (value instanceof Date) {
    return value;
  }

  if (Array.isArray(value)) {
    let changed = false;
    const mapped = value.map((item) => {
      const next = redactHiddenMentions(item, depth + 1);
      if (next !== item) {
        changed = true;
      }
      return next;
    });
    return (changed ? mapped : value) as unknown as T;
  }

  const record = value as Record<string, unknown>;
  const hidden = isHiddenMention(record);

  let result: Record<string, unknown> | null = null;

  if (hidden) {
    result = { ...record };
    for (const field of REDACTED_FIELDS) {
      delete result[field];
    }
    // The frontend types `Mention.url` as `string | null`, so send an explicit null rather than
    // dropping the key — a missing key reads as "the API is broken", an explicit null reads as
    // "there is no link to show" (see MentionCard.tsx).
    result.url = null;
    result.reprints = [];

    for (const field of SCRUBBED_TEXT_FIELDS) {
      if (typeof result[field] === 'string') {
        result[field] = (result[field] as string).replace(URL_IN_TEXT, URL_PLACEHOLDER);
      }
    }
  }

  for (const [key, child] of Object.entries(record)) {
    if (
      hidden &&
      ((REDACTED_FIELDS as readonly string[]).includes(key) || (SCRUBBED_TEXT_FIELDS as readonly string[]).includes(key))
    ) {
      continue;
    }
    const next = redactHiddenMentions(child, depth + 1);
    if (next !== child) {
      result = result ?? { ...record };
      result[key] = next;
    }
  }

  return (result ?? record) as unknown as T;
}
