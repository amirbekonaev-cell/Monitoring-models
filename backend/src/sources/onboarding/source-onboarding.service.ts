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
import { runCollectionCycle } from '../../common/collector-run.util';
import { DomainExclusionService } from '../../common/domain-exclusion.service';

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
      fetchItems: (s) => this.fetchByType(detection.type, s.url),
    });

    const refreshed = await this.sourcesService.findById(source.id);

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
      message:
        summary.itemsFound === 0
          ? 'Источник подключён, но при первом сборе материалов не нашлось — попробуем ещё раз по расписанию.'
          : `Нашлось ${summary.itemsFound} материал(ов), из них новых: ${summary.itemsNew}.`,
    };
  }

  private fetchByType(type: SourceKind, url: string) {
    switch (type) {
      case SourceKind.RSS:
        return this.rssService.fetchFeed(url);
      case SourceKind.TELEGRAM:
        return this.telegramService.fetchChannel(url);
      case SourceKind.PARSER:
        return this.parserService.fetchPage(url);
      default:
        throw new Error(`Добавление источника по ссылке не поддерживается для типа ${type}`);
    }
  }
}