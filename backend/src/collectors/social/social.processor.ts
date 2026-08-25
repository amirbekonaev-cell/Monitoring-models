import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { VkService } from './vk.service';
import { SourcesService } from '../../sources/sources.service';
import { MentionsService } from '../../mentions/mentions.service';
import { KeywordsService } from '../../keywords/keywords.service';
import { SourceKind } from '../../sources/source.entity';
import { MentionSourceType } from '../../mentions/mention.entity';
import { runCollectionCycle } from '../../common/collector-run.util';

export const SOCIAL_COLLECT_QUEUE = 'social-collect';

@Processor(SOCIAL_COLLECT_QUEUE)
export class SocialProcessor extends WorkerHost {
  private readonly logger = new Logger(SocialProcessor.name);

  constructor(
    private readonly vkService: VkService,
    private readonly sourcesService: SourcesService,
    private readonly mentionsService: MentionsService,
    private readonly keywordsService: KeywordsService,
  ) {
    super();
  }

  async process(_job: Job): Promise<void> {
    const sources = await this.sourcesService.findActiveByType(SourceKind.SOCIAL_API);
    const activeKeywords = (await this.keywordsService.findAll()).filter((k) => k.isActive);

    await runCollectionCycle({
      logger: this.logger,
      channelName: 'Social API (VK)',
      sources,
      sourcesService: this.sourcesService,
      mentionsService: this.mentionsService,
      keywordsService: this.keywordsService,
      sourceType: MentionSourceType.SOCIAL,
      fetchItems: () => this.vkService.search(activeKeywords),
    });
  }
}
