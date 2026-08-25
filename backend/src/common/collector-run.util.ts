import { Logger } from '@nestjs/common';
import { Source } from '../sources/source.entity';
import { SourcesService } from '../sources/sources.service';
import { MentionsService } from '../mentions/mentions.service';
import { Mention } from '../mentions/mention.entity';
import { ActiveKeywordSet, KeywordsService } from '../keywords/keywords.service';
import { SettingsService } from '../settings/settings.service';
import { DomainExclusionService } from './domain-exclusion.service';

// Stateless (reads process.env fresh on every call) — instantiated directly here rather than
// injected, same reasoning as getBackfillDays/isNotifiableSourceType below: this file is a plain
// function, not part of Nest DI, and is called from every collector channel including K-1
// (NewsAPI) and K-6 (OpenAI web search), which search the whole web and can return a blacklisted
// domain that was never explicitly added as a source.
const domainExclusionService = new DomainExclusionService();

export interface CollectedItem {
  title: string;
  text: string;
  url: string;
  publishedAt: Date | null;
  hash: string;
  /**
   * Human-readable source/platform label for this specific item (e.g. a domain like
   * "instagram.com" or "kz-forum.example"). Optional: only channels that don't already have a
   * one-source-per-site model (currently just the consolidated OpenAI web search, K-6) need to
   * carry it per item — everything else is already attributable via source_id -> sources.name.
   */
  sourceLabel?: string | null;
}

export interface CollectorCycleSummary {
  sourcesOk: number;
  sourcesFailed: number;
  itemsFound: number;
  itemsNew: number;
  itemsReprint: number;
  itemsFilteredByKeywords: number;
  itemsFilteredByExcludedDomain: number;
  itemsSkippedOldBackfill: number;
  /** True when this call did nothing because collection is globally paused (see SettingsService). */
  paused: boolean;
}

function emptySummary(paused: boolean): CollectorCycleSummary {
  return {
    sourcesOk: 0,
    sourcesFailed: 0,
    itemsFound: 0,
    itemsNew: 0,
    itemsReprint: 0,
    itemsFilteredByKeywords: 0,
    itemsFilteredByExcludedDomain: 0,
    itemsSkippedOldBackfill: 0,
    paused,
  };
}

/**
 * Runs one collection cycle over a list of sources for a single channel. Each source is
 * isolated in its own try/catch (ФТ-2: one broken source must never take down the others
 * or the rest of the cycle) and its status is updated in the sources registry either way.
 */
export async function runCollectionCycle(params: {
  logger: Logger;
  channelName: string;
  sources: Source[];
  sourcesService: SourcesService;
  mentionsService: MentionsService;
  keywordsService: KeywordsService;
  settingsService: SettingsService;
  sourceType: Mention['sourceType'];
  fetchItems: (source: Source) => Promise<CollectedItem[]>;
  /**
   * Disables dedup (hash + similarity) for every item this cycle inserts — see
   * CreateMentionInput.skipDedup for why. Only the consolidated OpenAI web search channel (К-6)
   * passes true; every other channel keeps normal reprint/duplicate detection.
   */
  skipDedup?: boolean;
}): Promise<CollectorCycleSummary> {
  const {
    logger,
    channelName,
    sources,
    sourcesService,
    mentionsService,
    keywordsService,
    settingsService,
    sourceType,
    fetchItems,
    skipDedup,
  } = params;

  // Global admin on/off switch (settings.collection_enabled). Checked before doing anything else,
  // and before even the "cycle start" log line — this is a no-op cycle, not a failed one. There's
  // no scheduled background collection any more (see README "Деплой на Vercel") — this function is
  // only reached now via the "add by link" onboarding flow's immediate test collection.
  if (!(await settingsService.isCollectionEnabled())) {
    logger.log(`${channelName}: сбор приостановлен (collection_enabled=false) — пропускаю цикл`);
    return emptySummary(true);
  }

  logger.log(`${channelName} cycle start: ${sources.length} active source(s) to poll`);

  const summary: CollectorCycleSummary = emptySummary(false);

  // Snapshot once per cycle: keyword edits mid-cycle apply to the *next* cycle, not this one.
  const keywordSet = await keywordsService.loadActiveKeywordSet();
  const backfillDays = getBackfillDays();

  for (const source of sources) {
    // A source that has never completed a successful cycle is doing its one-time historical
    // catch-up run right now: everything it finds this cycle is tagged is_backfill=true and
    // considered already-notified, so the admin gets a log summary instead of a burst of
    // Telegram messages. Every cycle afterwards (once lastSuccessAt is set) is normal monitoring.
    const isBackfill = source.lastSuccessAt === null;
    // Best-effort only: applied when an item actually carries a publishedAt. A feed/page that
    // doesn't expose dates at all (or genuinely can't reach this far back) isn't held to it —
    // there's no way to enforce a depth the source itself doesn't offer.
    const backfillCutoff = isBackfill ? new Date(Date.now() - backfillDays * 24 * 60 * 60 * 1000) : null;
    let sourceItemsNew = 0;
    let sourceItemsSkippedOld = 0;

    try {
      const items = await fetchItems(source);
      summary.itemsFound += items.length;

      for (const item of items) {
        if (backfillCutoff && item.publishedAt && item.publishedAt < backfillCutoff) {
          summary.itemsSkippedOldBackfill += 1;
          sourceItemsSkippedOld += 1;
          continue;
        }

        // Blocks a blacklisted domain from ever reaching mentions — matters most for K-1/K-6,
        // which search the whole web and have no fixed list of sites to pre-filter by. Checked
        // via item.url (present on every channel) rather than sourceLabel, since sourceLabel is
        // itself derived from the same URL for the one channel (K-6) that sets it.
        if (domainExclusionService.isUrlExcluded(item.url)) {
          summary.itemsFilteredByExcludedDomain += 1;
          continue;
        }

        const { matched } = await matchKeywords(keywordSet, item);
        if (!matched) {
          summary.itemsFilteredByKeywords += 1;
          continue;
        }

        const result = await mentionsService.createIfNew({
          title: item.title,
          text: item.text,
          url: item.url,
          publishedAt: item.publishedAt,
          sourceId: source.id,
          sourceType,
          sourceLabel: item.sourceLabel ?? null,
          hash: item.hash,
          keywords: [],
          isBackfill,
          skipDedup,
        });

        if (result === 'inserted') {
          summary.itemsNew += 1;
          sourceItemsNew += 1;
        } else if (result === 'reprint') {
          summary.itemsReprint += 1;
        }
      }

      await sourcesService.markSuccess(source.id);
      summary.sourcesOk += 1;

      if (isBackfill) {
        logger.log(
          `Backfill (${channelName}): источник ${source.url} — найдено ${sourceItemsNew} упоминани(й) за последние ` +
            `${backfillDays} дней (best-effort; пропущено как более старые: ${sourceItemsSkippedOld}); ` +
            'уведомления по ним в Telegram не отправляются (is_backfill=true, notification_sent=true).',
        );
      }
    } catch (error) {
      summary.sourcesFailed += 1;
      const message = describeError(error);
      logger.error(`${channelName} source failed: ${source.url} — ${message}`);
      await sourcesService.markError(source.id, message);
    }
  }

  logger.log(
    `${channelName} cycle done: sources ok=${summary.sourcesOk} failed=${summary.sourcesFailed}, ` +
      `items found=${summary.itemsFound} new=${summary.itemsNew} reprints=${summary.itemsReprint} ` +
      `filtered=${summary.itemsFilteredByKeywords} filteredByExcludedDomain=${summary.itemsFilteredByExcludedDomain} ` +
      `skippedOldBackfill=${summary.itemsSkippedOldBackfill}`,
  );

  return summary;
}

async function matchKeywords(keywordSet: ActiveKeywordSet, item: CollectedItem) {
  return keywordSet.match(item.title, item.text);
}

/**
 * Node's fetch (undici) wraps the actually-useful reason (DNS failure, broken TLS certificate
 * chain, connection refused, ...) in `error.cause` and leaves `error.message` as the generic
 * "fetch failed" — which on its own is a stack-trace-shaped non-answer, not the "понятная
 * причина ошибки текстом" this project promises admins. Surface the cause too when present.
 */
function describeError(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }
  const cause = (error as Error & { cause?: unknown }).cause;
  if (cause instanceof Error && cause.message && cause.message !== error.message) {
    return `${error.message}: ${cause.message}`;
  }
  return error.message;
}

/**
 * BACKFILL_DAYS — how far back a source's first (backfill) cycle reaches, best-effort. Read
 * directly from process.env (this is a plain function, not part of Nest DI); documented
 * alongside every other setting in config/configuration.ts as `backfill.days` for anyone wiring
 * it through ConfigService instead. Defaults to 60 (~2 months) when unset or not a positive number.
 */
function getBackfillDays(): number {
  const parsed = parseInt(process.env.BACKFILL_DAYS ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 60;
}
