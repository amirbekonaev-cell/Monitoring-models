import { createHash } from 'crypto';

/**
 * Normalization + identity for a closed-pool link. Deliberately a pure function file with no
 * imports from the rest of the app: it is the single definition of "the same link" shared by the
 * import script, the ingestion service and the tests.
 *
 * What is stripped and what is kept was decided against the actual pool, not in the abstract:
 * - host is lowercased (hostnames are case-insensitive; the path is NOT — several pool links use
 *   mixed-case slugs, e.g. profit.kz's `/Kasim-Esergepov-.../`, and lowercasing those 404s);
 * - `#fragment` is dropped (never part of a page's identity);
 * - `utm_*` params are dropped (campaign tagging, not identity);
 * - the rest of the query string is KEPT. ekaraganda.kz serves every article from
 *   `/?mod=news_read&id=NNNNN` — the id lives in the query, so dropping it would collapse all
 *   five of its links into one.
 * - a trailing slash is dropped only when the path is longer than "/" — `https://example.com/`
 *   and `https://example.com` are the same page, but so are `/a/b/` and `/a/b`, while stripping
 *   the slash off a bare root would leave an empty path.
 */

const TRACKING_PARAM_PREFIXES = ['utm_'];

export function normalizeCuratedUrl(rawUrl: string): string {
  const parsed = new URL(rawUrl.trim());

  parsed.hostname = parsed.hostname.toLowerCase();
  parsed.protocol = parsed.protocol.toLowerCase();
  parsed.hash = '';

  for (const key of [...parsed.searchParams.keys()]) {
    if (TRACKING_PARAM_PREFIXES.some((prefix) => key.toLowerCase().startsWith(prefix))) {
      parsed.searchParams.delete(key);
    }
  }

  if (parsed.pathname.length > 1 && parsed.pathname.endsWith('/')) {
    parsed.pathname = parsed.pathname.replace(/\/+$/, '');
  }

  return parsed.toString();
}

/** sha256 of the normalized URL — the `curated_links.url_hash` dedup key. */
export function curatedUrlHash(rawUrl: string): string {
  return createHash('sha256').update(normalizeCuratedUrl(rawUrl)).digest('hex');
}

/** Host without `www.`, for `curated_links.host` and for per-host request queueing/logging. */
export function curatedHost(rawUrl: string): string {
  return new URL(rawUrl.trim()).hostname.toLowerCase().replace(/^www\./, '');
}

/**
 * The only form of a pool URL that may ever reach a log line: the link's row id plus its host.
 * Everything that logs about a link goes through this — never `link.url` — so a full pool URL
 * cannot leak into application or script output. See README "Приватность".
 */
export function curatedLinkRef(id: string, host: string | null): string {
  return `link ${id.slice(0, 8)} @ ${host ?? 'unknown-host'}`;
}
