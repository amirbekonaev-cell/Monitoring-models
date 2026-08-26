import { Logger } from '@nestjs/common';
import { Source } from '../../sources/source.entity';
import { SourcesService } from '../../sources/sources.service';
import { RssService } from './rss.service';
import { ParserService } from '../parser/parser.service';
import { CollectedItem } from '../../common/collector-run.util';

// How often we re-run the sitemap/HTML-pagination deep pass for a source that's already been
// through its one-time backfill. RSS itself is polled on every /search call already — the deep
// pass only exists to catch whatever scrolled out of the feed between two such passes, so there's
// no value in re-walking the whole sitemap on every single /search.
const DEEP_SCAN_INTERVAL_HOURS = parseInt(process.env.RSS_DEEP_SCAN_INTERVAL_HOURS || '24', 10);

// A routine (non-backfill) deep pass only needs to look back far enough to bridge the gap between
// two deep passes, not the full BACKFILL_DAYS archive — walking the whole sitemap every day would
// defeat the point of pruning by <lastmod>.
const DEEP_SCAN_LOOKBACK_DAYS = parseInt(process.env.RSS_DEEP_SCAN_LOOKBACK_DAYS || '7', 10);

function getBackfillDays(): number {
  const parsed = parseInt(process.env.BACKFILL_DAYS ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 60;
}

/**
 * RSS feeds only ever expose their last N items (see CLAUDE.md task on RSS backfill depth) — this
 * wraps the plain feed fetch with an additional, throttled К-5 deep pass (sitemap, or HTML
 * pagination as fallback — see ParserService.deepCollect) so material that already scrolled out of
 * the feed still gets picked up. A source's first-ever cycle (`lastSuccessAt === null`) gets the
 * full BACKFILL_DAYS window, same as the rest of the backfill logic in collector-run.util.ts;
 * every cycle after that only re-checks the last DEEP_SCAN_LOOKBACK_DAYS, and only once every
 * DEEP_SCAN_INTERVAL_HOURS (tracked via `sources.last_deep_scan_at`).
 *
 * Used by both SourceOnboardingService (one-time test collection) and OnDemandSearchService
 * (/search) so the two never drift — same reasoning as runCollectionCycle.
 */
export async function fetchRssWithDeepScan(params: {
  source: Source;
  logger: Logger;
  rssService: RssService;
  parserService: ParserService;
  sourcesService: SourcesService;
}): Promise<CollectedItem[]> {
  const { source, logger, rssService, parserService, sourcesService } = params;

  const feedItems = await rssService.fetchFeed(source.url);

  const isFirstEverRun = source.lastSuccessAt === null;
  // Distinct from isFirstEverRun: a source that's been happily polling its RSS feed for months
  // (lastSuccessAt long set) can still never have gone through a *deep* pass before — e.g. every
  // pre-existing source right after this feature ships, since the migration leaves
  // last_deep_scan_at NULL for all of them. That first deep pass deserves the full BACKFILL_DAYS
  // window too, same as a brand-new source's backfill — not the short routine top-up window,
  // which only makes sense once there's already a prior deep pass to bridge the gap from.
  const isFirstDeepScan = !source.lastDeepScanAt;
  const dueForDeepScan =
    !source.lastDeepScanAt || Date.now() - source.lastDeepScanAt.getTime() > DEEP_SCAN_INTERVAL_HOURS * 60 * 60 * 1000;

  if (!isFirstEverRun && !dueForDeepScan) {
    return feedItems;
  }

  const isFullBackfillPass = isFirstEverRun || isFirstDeepScan;
  const cutoff = isFullBackfillPass
    ? new Date(Date.now() - getBackfillDays() * 24 * 60 * 60 * 1000)
    : new Date(Date.now() - DEEP_SCAN_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  const maxPages = isFullBackfillPass ? parserService.getBackfillMaxPages() : parserService.getDefaultMaxPages();

  try {
    const deepItems = await parserService.deepCollect(source.url, cutoff, { fallbackMaxPages: maxPages });
    // Only recorded on a completed pass (even a zero-result one) — a thrown error below skips
    // this, so a transient failure gets retried on the next cycle instead of being throttled away.
    await sourcesService.markDeepScanDone(source.id);

    const seenUrls = new Set(feedItems.map((i) => i.url));
    const merged = [...feedItems];
    for (const item of deepItems) {
      if (!seenUrls.has(item.url)) {
        seenUrls.add(item.url);
        merged.push(item);
      }
    }
    return merged;
  } catch (error) {
    // Best-effort addition on top of RSS, not a replacement — one failing sitemap/crawl must
    // never take down the fast RSS path that already worked (ФТ-2 style isolation).
    logger.warn(`Глубокий проход (К-5 доп. к RSS) не удался для ${source.url}: ${String(error)}`);
    return feedItems;
  }
}
