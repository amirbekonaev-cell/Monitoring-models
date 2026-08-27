import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { SourceDetectService } from './source-detect.service';
import { SourcesService } from '../sources.service';
import { MentionsService } from '../../mentions/mentions.service';
import { KeywordsService } from '../../keywords/keywords.service';
import { SettingsService } from '../../settings/settings.service';
import { RssService } from '../../collectors/rss/rss.service';
import { TelegramService } from '../../collectors/telegram/telegram.service';
import { ParserService } from '../../collectors/parser/parser.service';
import { Source, SourceKind } from '../source.entity';
import { MentionSourceType } from '../../mentions/mention.entity';
import { runCollectionCycle, CollectedItem } from '../../common/collector-run.util';
import { DomainExclusionService } from '../../common/domain-exclusion.service';
import { fetchRssWithDeepScan } from '../../collectors/rss/rss-deep-scan.util';
import { fetchParserWithDeepScan, describeParserDeepScanNote } from '../../collectors/parser/parser-deep-scan.util';
import { ParserDeepScanStrategy } from '../../collectors/parser/parser.service';

// Onboarding's "Добавить по ссылке" is its own single Vercel Hobby request (60s hard cap — see
// telegram-bot.service.ts), same as /search, but only ever runs the deep pass for exactly one
// brand-new source — so unlike PARSER_ONDEMAND_SOURCE_BUDGET_MS in on-demand-search.service.ts
// (which has to be split across however many sources are due in one shared /search call), this can
// afford to use most of the whole request's budget on that one source.
const PARSER_ONBOARDING_TIME_BUDGET_MS = parseInt(process.env.PARSER_ONBOARDING_SOURCE_BUDGET_MS || '45000', 10);

const SOURCE_TYPE_TO_MENTION_TYPE: Record<SourceKind, MentionSourceType> = {
  [SourceKind.RSS]: MentionSourceType.NEWS,
  [SourceKind.PARSER]: MentionSourceType.OTHER,
  [SourceKind.TELEGRAM]: MentionSourceType.TELEGRAM,
  [SourceKind.SEARCH_API]: MentionSourceType.NEWS,
  [SourceKind.SOCIAL_API]: MentionSourceType.SOCIAL,
  // К-6 sources are only ever created by SocialSearchSchedulerService, never through "add by
  // link" onboarding — present here only so this map stays a total function over SourceKind.
  [SourceKind.SOCIAL_SEARCH_API]: MentionSourceType.SOCIAL_SEARCH,
};

export interface AddByLinkResult {
  source: Source | null;
  type: SourceKind;
  ok: boolean;
  itemsFound?: number;
  itemsNew?: number;
  itemsFilteredByKeywords?: number;
  message: string;
  /**
   * Only set for SourceKind.PARSER — which deep-scan path (sitemap/HTML-pagination/neither) the
   * one-time test collection actually took, so an admin adding a source by link can see *why*
   * without reading the backend log. See parser-deep-scan.util.ts's describeParserDeepScanNote.
   */
  deepScanNote?: string;
}

/**
 * Shared "add a source by link, then run one immediate test collection" logic — used by both
 * the HTTP endpoint (admin adding a source through the UI) and the bulk import script
 * (scripts/import-sources.ts), so the two never drift apart.
 */
@Injectable()
export class SourceOnboardingService {
  private readonly logger = new Logger(SourceOnboardingService.name);

  constructor(
    private readonly detectService: SourceDetectService,
    private readonly sourcesService: SourcesService,
    private readonly mentionsService: MentionsService,
    private readonly keywordsService: KeywordsService,
    private readonly settingsService: SettingsService,
    private readonly rssService: RssService,
    private readonly telegramService: TelegramService,
    private readonly parserService: ParserService,
    private readonly domainExclusionService: DomainExclusionService,
  ) {}

  async addByLink(rawUrlInput: string, name: string | null, createdBy: string): Promise<AddByLinkResult> {
    const rawUrl = (rawUrlInput ?? '').trim();
    if (!rawUrl) {
      throw new BadRequestException('Укажите ссылку на источник');
    }

    // Checked before we even try to detect/reach the URL — a blacklisted domain must never be
    // added regardless of what type it would otherwise resolve to (ФТ: домен в списке исключений).
    if (this.domainExclusionService.isUrlExcluded(rawUrl)) {
      throw new BadRequestException(`Домен из ссылки «${rawUrl}» в списке исключений (EXCLUDED_DOMAINS) — источник не добавлен`);
    }

    const detection = await this.detectService.detect(rawUrl);

    const existing = await this.sourcesService.findByUrl(detection.resolvedUrl);
    if (existing) {
      throw new BadRequestException(`Такой источник уже добавлен: ${detection.resolvedUrl}`);
    }

    const source = await this.sourcesService.create({
      url: detection.resolvedUrl,
      name,
      type: detection.type,
      createdBy,
    });

    // Only meaningful for SourceKind.PARSER — captured via closure since fetchItems below must
    // keep returning a plain Promise<CollectedItem[]> for runCollectionCycle, with no room to also
    // hand back which deep-scan strategy ran.
    let parserDeepScanStrategy: ParserDeepScanStrategy | null = null;

    // Immediate test collection: whoever added the source sees right away whether it actually
    // works and what it finds — no waiting for the next scheduled cycle, no stack traces.
    const summary = await runCollectionCycle({
      logger: this.logger,
      channelName: `Onboarding(${detection.type})`,
      sources: [source],
      sourcesService: this.sourcesService,
      mentionsService: this.mentionsService,
      keywordsService: this.keywordsService,
      settingsService: this.settingsService,
      sourceType: SOURCE_TYPE_TO_MENTION_TYPE[detection.type],
      fetchItems: async (s) => {
        if (detection.type === SourceKind.PARSER) {
          const result = await fetchParserWithDeepScan({
            source: s,
            logger: this.logger,
            parserService: this.parserService,
            sourcesService: this.sourcesService,
            budget: { deadline: Date.now() + PARSER_ONBOARDING_TIME_BUDGET_MS },
          });
          parserDeepScanStrategy = result.strategy;
          return result.items;
        }
        return this.fetchByType(detection.type, s);
      },
    });

    const refreshed = await this.sourcesService.findById(source.id);
    const deepScanNote =
      detection.type === SourceKind.PARSER && parserDeepScanStrategy
        ? describeParserDeepScanNote(parserDeepScanStrategy, summary.itemsFound)
        : undefined;

    if (summary.paused) {
      return {
        source: refreshed,
        type: detection.type,
        ok: true,
        message:
          'Источник добавлен, но сбор сейчас на паузе (/resume в Telegram-группе, чтобы возобновить) — ' +
          'тестовый сбор пройдёт автоматически после возобновления.',
      };
    }

    if (summary.sourcesFailed > 0) {
      return {
        source: refreshed,
        type: detection.type,
        ok: false,
        deepScanNote,
        message: refreshed?.lastError ?? 'Не удалось подключиться к источнику',
      };
    }

    return {
      source: refreshed,
      type: detection.type,
      ok: true,
      itemsFound: summary.itemsFound,
      itemsNew: summary.itemsNew,
      itemsFilteredByKeywords: summary.itemsFilteredByKeywords,
      deepScanNote,
      message:
        summary.itemsFound === 0
          ? 'Источник подключён, но при первом сборе материалов не нашлось — попробуем ещё раз по расписанию.'
          : `Нашлось ${summary.itemsFound} материал(ов), из них новых: ${summary.itemsNew}.`,
    };
  }

  private fetchByType(type: SourceKind, source: Source): Promise<CollectedItem[]> {
    switch (type) {
      // RSS on its own only ever surfaces a feed's last N items — layer the throttled sitemap/
      // HTML-pagination deep pass on top so the source's one-time backfill (lastSuccessAt still
      // null at this point, since this *is* that first cycle) actually reaches BACKFILL_DAYS back,
      // not just however far the feed itself happens to go. See rss-deep-scan.util.ts.
      case SourceKind.RSS:
        return fetchRssWithDeepScan({
          source,
          logger: this.logger,
          rssService: this.rssService,
          parserService: this.parserService,
          sourcesService: this.sourcesService,
          // Same reasoning as the PARSER branch above: this HTTP request is also bound by
          // Vercel's 60s Hobby cap, and an unbounded deep pass on a brand-new RSS source's first
          // (full BACKFILL_DAYS) cycle can run long — see the incident note in
          // rss-deep-scan.util.ts.
          budget: { deadline: Date.now() + PARSER_ONBOARDING_TIME_BUDGET_MS },
        });
      case SourceKind.TELEGRAM:
        return this.telegramService.fetchChannel(source.url);
      // SourceKind.PARSER is handled directly in addByLink()'s fetchItems closure, not here — it
      // needs to capture fetchParserWithDeepScan's `strategy` for deepScanNote, which this
      // method's Promise<CollectedItem[]> return type has no room for.
      default:
        throw new Error(`Добавление источника по ссылке не поддерживается для типа ${type}`);
    }
  }
}