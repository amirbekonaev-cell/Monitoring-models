import { Logger } from '@nestjs/common';
import { Source } from '../../sources/source.entity';
import { SourcesService } from '../../sources/sources.service';
import { ParserService, ParserDeepScanStrategy, DeepScanBudget } from './parser.service';
import { CollectedItem } from '../../common/collector-run.util';

// A PARSER source (SourceKind.PARSER — no RSS/Atom feed could be auto-detected for it, see
// source-detect.service.ts) previously only ever had ParserService.fetchPage() called on it: a
// single request against the source's own URL (usually the homepage), parsed as if that page were
// the one and only article. No real article on the site was ever read — see CLAUDE.md task
// diagnostics (sknews.kz never surfaced any mention because of exactly this). This is the PARSER
// equivalent of rss-deep-scan.util.ts's fetchRssWithDeepScan: it's the *only* code path that
// actually walks the site (sitemap, or HTML pagination as fallback — ParserService.deepCollect).
//
// Unlike RSS, there's no cheap "fast path" to fall back to between deep passes — a PARSER source
// has no feed at all. So instead of merging a fast fetch with an occasional deep pass (RSS's
// model), this returns nothing (`strategy: 'skipped'`) when a deep pass isn't due yet; the next
// /search that finds it due will pick up whatever's new since the last one, same as RSS's routine
// window.
//
// TODO (separate task, not this fix): a site with neither a working sitemap nor pagination the
// crawler can follow (JS/AJAX "load more" buttons instead of a real <a href> — confirmed live on
// sknews.kz, see README "Исправление: PARSER-источники не проходили глубокий обход") is stuck at
// `strategy: 'none'`/one listing page deep, no matter how this file is tuned — there is no archive
// left to walk. The real fix for *that* class of source is a third collection path: the site's own
// on-site search (e.g. sknews.kz/search), queried per active keyword, parsing whatever result links
// it returns via ParserService's existing parseArticlePage. Needs manual DevTools inspection per
// site (which query param/method the search actually uses) — not something this generic crawler can
// discover on its own.

// Reused, not duplicated: this is the exact same sitemap/HTML-pagination deep pass RSS layers on
// top of its feed (ParserService.deepCollect) with the exact same throttling semantics
// (sources.last_deep_scan_at / SourcesService.markDeepScanDone), so RSS_DEEP_SCAN_INTERVAL_HOURS/
// RSS_DEEP_SCAN_LOOKBACK_DAYS govern both — a PARSER-specific pair of env vars would just be two
// more names for the identical setting. The "RSS_" prefix on the variable *names* is legacy (they
// shipped before this file existed) and intentionally left alone so already-configured
// deployments (e.g. Vercel env vars) don't silently stop working after this change — see
// README "Исправление: PARSER-источники не проходили глубокий обход".
const DEEP_SCAN_INTERVAL_HOURS = parseInt(process.env.RSS_DEEP_SCAN_INTERVAL_HOURS || '24', 10);
const DEEP_SCAN_LOOKBACK_DAYS = parseInt(process.env.RSS_DEEP_SCAN_LOOKBACK_DAYS || '7', 10);

function getBackfillDays(): number {
  const parsed = parseInt(process.env.BACKFILL_DAYS ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 60;
}

export interface ParserDeepScanResult {
  items: CollectedItem[];
  strategy: ParserDeepScanStrategy;
}

/**
 * Runs the sitemap/HTML-pagination deep pass for a PARSER source and nothing else — see the
 * file-level comment for why there's no separate "fast path" to merge with, unlike
 * fetchRssWithDeepScan. Used by both SourceOnboardingService (one-time test collection, which also
 * uses `strategy` to build an admin-facing deepScanNote) and OnDemandSearchService (/search) so the
 * two never drift — same reasoning as fetchRssWithDeepScan.
 *
 * `budget` is required (not optional, unlike ParserService.deepCollect's own DeepScanBudget) —
 * every caller of this function sits inside a single Vercel Hobby request capped at 60s (see
 * telegram-bot.service.ts), so there is no legitimate caller that should run this unbounded.
 */
export async function fetchParserWithDeepScan(params: {
  source: Source;
  logger: Logger;
  parserService: ParserService;
  sourcesService: SourcesService;
  budget: DeepScanBudget & { deadline: number };
}): Promise<ParserDeepScanResult> {
  const { source, logger, parserService, sourcesService, budget } = params;

  const isFirstEverRun = source.lastSuccessAt === null;
  // Same reasoning as fetchRssWithDeepScan.isFirstDeepScan: a source that's had lastSuccessAt set
  // for a while but never gone through last_deep_scan_at (e.g. every PARSER source that existed
  // before this feature shipped) still deserves the full BACKFILL_DAYS window on its first deep
  // pass, not the short routine one.
  const isFirstDeepScan = !source.lastDeepScanAt;
  const dueForDeepScan =
    !source.lastDeepScanAt || Date.now() - source.lastDeepScanAt.getTime() > DEEP_SCAN_INTERVAL_HOURS * 60 * 60 * 1000;

  if (!isFirstEverRun && !dueForDeepScan) {
    logger.log(`fetchParserWithDeepScan: ${source.url} — не время для очередного глубокого прохода, пропускаю`);
    return { items: [], strategy: 'skipped' };
  }

  const isFullBackfillPass = isFirstEverRun || isFirstDeepScan;
  const cutoff = isFullBackfillPass
    ? new Date(Date.now() - getBackfillDays() * 24 * 60 * 60 * 1000)
    : new Date(Date.now() - DEEP_SCAN_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  const maxPages = isFullBackfillPass ? parserService.getBackfillMaxPages() : parserService.getDefaultMaxPages();

  try {
    const { items, strategy } = await parserService.deepCollect(source.url, cutoff, {
      fallbackMaxPages: maxPages,
      ...budget,
    });
    // Only recorded on a completed pass (even a zero-result one, including one cut short by the
    // time budget) — a thrown error below skips this, so a transient failure gets retried on the
    // next cycle instead of being throttled away.
    await sourcesService.markDeepScanDone(source.id);
    return { items, strategy };
  } catch (error) {
    // Isolated the same way as RSS's deep pass (ФТ-2) — one source's sitemap/crawl blowing up must
    // never take down the rest of /search's channels or sources.
    logger.warn(`Глубокий проход (К-5, источник без RSS) не удался для ${source.url}: ${String(error)}`);
    return { items: [], strategy: 'error' };
  }
}

/**
 * Admin-facing note for the "Добавить по ссылке" form (SourceOnboardingService.addByLink) —
 * surfaces which deep-scan path actually ran, or why none did, instead of that only ever showing
 * up in the backend log. Only meaningful for SourceKind.PARSER; RSS sources aren't affected by
 * this since their fast feed path always returns *something* to show even when the deep pass finds
 * nothing extra.
 */
export function describeParserDeepScanNote(strategy: ParserDeepScanStrategy, itemsFound: number): string {
  switch (strategy) {
    case 'sitemap':
      return `Глубокий обход: использован sitemap источника, найдено материалов: ${itemsFound}.`;
    case 'html-pagination':
      return `Глубокий обход: sitemap не найден, использована HTML-пагинация листинга, найдено материалов: ${itemsFound}.`;
    case 'none':
      return (
        'Глубокий обход недоступен: ни sitemap, ни HTML-пагинация не дали ссылок на статьи ' +
        '(возможно, раздел новостей рендерится через JS) — источник добавлен, но пока не может ' +
        'собирать материалы автоматически.'
      );
    case 'skipped':
      return 'Глубокий обход отложен: этот источник уже проверялся недавно, следующий проход пройдёт по расписанию /search.';
    case 'error':
      return 'Глубокий обход завершился ошибкой при первом подключении — источник добавлен, следующая попытка пройдёт при очередном /search.';
  }
}
