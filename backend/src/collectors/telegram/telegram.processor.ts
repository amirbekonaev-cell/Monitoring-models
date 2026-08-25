import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { TelegramService } from './telegram.service';
import { SourcesService } from '../../sources/sources.service';
import { MentionsService } from '../../mentions/mentions.service';
import { KeywordsService } from '../../keywords/keywords.service';
import { SourceKind } from '../../sources/source.entity';
import { MentionSourceType } from '../../mentions/mention.entity';
import { runCollectionCycle } from '../../common/collector-run.util';

export const TELEGRAM_COLLECT_QUEUE = 'telegram-collect';

@Processor(TELEGRAM_COLLECT_QUEUE)
export class TelegramProcessor extends WorkerHost {
  private readonly logger = new Logger(TelegramProcessor.name);

  constructor(
    private readonly telegramService: TelegramService,
    private readonly sourcesService: SourcesService,
    private readonly mentionsService: MentionsService,
    private readonly keywordsService: KeywordsService,
  ) {
    super();
  }

  async process(_job: Job): Promise<void> {
    const sources = await this.sourcesService.findActiveByType(SourceKind.TELEGRAM);
    await runCollectionCycle({
      logger: this.logger,
      channelName: 'Telegram',
      sources,
      sourcesService: this.sourcesService,
      mentionsService: this.mentionsService,
      keywordsService: this.keywordsService,
      sourceType: MentionSourceType.TELEGRAM,
      fetchItems: (source) => this.telegramService.fetchChannel(source.url),
    });
  }
}
