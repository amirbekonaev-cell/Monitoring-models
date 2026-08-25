import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { RssService } from './rss.service';
import { SourcesService } from '../../sources/sources.service';
import { MentionsService } from '../../mentions/mentions.service';
import { KeywordsService } from '../../keywords/keywords.service';
import { SourceKind } from '../../sources/source.entity';
import { MentionSourceType } from '../../mentions/mention.entity';
import { runCollectionCycle } from '../../common/collector-run.util';

export const RSS_COLLECT_QUEUE = 'rss-collect';

@Processor(RSS_COLLECT_QUEUE)
export class RssProcessor extends WorkerHost {
  private readonly logger = new Logger(RssProcessor.name);

  constructor(
    private readonly rssService: RssService,
    private readonly sourcesService: SourcesService,
    private readonly mentionsService: MentionsService,
    private readonly keywordsService: KeywordsService,
  ) {
    super();
  }

  async process(_job: Job): Promise<void> {
    const sources = await this.sourcesService.findActiveByType(SourceKind.RSS);
    await runCollectionCycle({
      logger: this.logger,
      channelName: 'RSS',
      sources,
      sourcesService: this.sourcesService,
      mentionsService: this.mentionsService,
      keywordsService: this.keywordsService,
      sourceType: MentionSourceType.NEWS,
      fetchItems: (source) => this.rssService.fetchFeed(source.url),
    });
  }
}
