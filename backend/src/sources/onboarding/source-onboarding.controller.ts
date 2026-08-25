import { BadRequestException, Body, Controller, Logger, Post } from '@nestjs/common';
import { SourceDetectService } from './source-detect.service';
import { SourcesService } from '../sources.service';
import { MentionsService } from '../../mentions/mentions.service';
import { KeywordsService } from '../../keywords/keywords.service';
import { RssService } from '../../collectors/rss/rss.service';
import { TelegramService } from '../../collectors/telegram/telegram.service';
import { ParserService } from '../../collectors/parser/parser.service';
import { SourceKind } from '../source.entity';
import { MentionSourceType } from '../../mentions/mention.entity';
import { runCollectionCycle } from '../../common/collector-run.util';

const SOURCE_TYPE_TO_MENTION_TYPE: Record<SourceKind, MentionSourceType> = {
  [SourceKind.RSS]: MentionSourceType.NEWS,
  [SourceKind.PARSER]: MentionSourceType.OTHER,
  [SourceKind.TELEGRAM]: MentionSourceType.TELEGRAM,
  [SourceKind.SEARCH_API]: MentionSourceType.NEWS,
  [SourceKind.SOCIAL_API]: MentionSourceType.SOCIAL,
};

@Controller('sources')
export class SourceOnboardingController {
  private readonly logger = new Logger(SourceOnboardingController.name);

  constructor(
    private readonly detectService: SourceDetectService,
    private readonly sourcesService: SourcesService,
    private readonly mentionsService: MentionsService,
    private readonly keywordsService: KeywordsService,
    private readonly rssService: RssService,
    private readonly telegramService: TelegramService,
    private readonly parserService: ParserService,
  ) {}

  @Post()
  async addByLink(@Body() body: { url: string; name?: string }) {
    const rawUrl = (body.url ?? '').trim();
    if (!rawUrl) {
      throw new BadRequestException('Укажите ссылку на источник');
    }

    const detection = await this.detectService.detect(rawUrl);

    const existing = await this.sourcesService.findByUrl(detection.resolvedUrl);
    if (existing) {
      throw new BadRequestException(`Такой источник уже добавлен: ${detection.resolvedUrl}`);
    }

    const source = await this.sourcesService.create({
      url: detection.resolvedUrl,
      name: body.name?.trim() || null,
      type: detection.type,
      createdBy: 'admin',
    });

    // Immediate test collection: the admin sees right away whether the source actually
    // works and what it finds — no waiting for the next scheduled cycle, no stack traces.
    const summary = await runCollectionCycle({
      logger: this.logger,
      channelName: `Onboarding(${detection.type})`,
      sources: [source],
      sourcesService: this.sourcesService,
      mentionsService: this.mentionsService,
      keywordsService: this.keywordsService,
      sourceType: SOURCE_TYPE_TO_MENTION_TYPE[detection.type],
      fetchItems: (s) => this.fetchByType(detection.type, s.url),
    });

    const refreshed = await this.sourcesService.findById(source.id);

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
