import { curatedHost, curatedUrlHash, normalizeCuratedUrl } from './curated-url.util';

/**
 * Parser for the closed-pool links file (`backend/data/curated-links.txt`, never committed —
 * see README "Приватность"). The format is deliberately the plainest thing a human can maintain
 * by hand in a text editor:
 *
 *   Tech                 <- any non-empty line that is not a URL is a GROUP HEADING
 *   https://a.example/1  <- ...and applies to every URL line until the next heading
 *   https://a.example/2
 *
 *   bluescreen
 *   https://b.example/x
 *
 * Blank lines are ignored (they only separate groups visually) and every line is trimmed — the
 * real file has trailing spaces on several URL lines, which would otherwise make `new URL()`
 * throw or produce a URL with a stray space in it.
 *
 * A URL that appears before any heading gets `groupLabel: null` rather than being dropped; a
 * duplicate (after normalization) is counted, not an error — the pool is hand-maintained and a
 * repeated link is a typo, not a reason to refuse the whole file.
 */

export interface ParsedCuratedLink {
  /** The URL exactly as normalizeCuratedUrl() produced it — this is what gets stored. */
  url: string;
  urlHash: string;
  host: string;
  groupLabel: string | null;
  /** 1-based line number in the source file — for reporting a malformed line without printing it. */
  line: number;
}

export interface ParsedCuratedFile {
  links: ParsedCuratedLink[];
  /** Counters only — the caller prints these; it never prints a URL. */
  stats: {
    totalLines: number;
    urlLines: number;
    uniqueUrls: number;
    duplicateUrls: number;
    groups: number;
    malformedUrls: number;
  };
  /** Line numbers of URL-looking lines that `new URL()` refused — reported without their content. */
  malformedLines: number[];
}

const URL_LINE = /^https?:\/\//i;

export function parseCuratedLinksFile(content: string): ParsedCuratedFile {
  const lines = content.split(/\r?\n/);
  const links: ParsedCuratedLink[] = [];
  const seenHashes = new Set<string>();
  const groups = new Set<string>();
  const malformedLines: number[] = [];

  let currentGroup: string | null = null;
  let urlLines = 0;
  let duplicateUrls = 0;

  lines.forEach((rawLine, index) => {
    const line = rawLine.trim();
    if (!line) {
      return;
    }

    if (!URL_LINE.test(line)) {
      currentGroup = line;
      groups.add(line);
      return;
    }

    urlLines += 1;

    let url: string;
    let urlHash: string;
    let host: string;
    try {
      url = normalizeCuratedUrl(line);
      urlHash = curatedUrlHash(line);
      host = curatedHost(line);
    } catch {
      malformedLines.push(index + 1);
      return;
    }

    if (seenHashes.has(urlHash)) {
      duplicateUrls += 1;
      return;
    }
    seenHashes.add(urlHash);

    links.push({ url, urlHash, host, groupLabel: currentGroup, line: index + 1 });
  });

  return {
    links,
    malformedLines,
    stats: {
      totalLines: lines.length,
      urlLines,
      uniqueUrls: links.length,
      duplicateUrls,
      groups: groups.size,
      malformedUrls: malformedLines.length,
    },
  };
}
