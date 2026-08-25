import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { SOCIAL_COLLECT_QUEUE, SocialProcessor } from './social.processor';
import { VkService } from './vk.service';
import { SocialSchedulerService } from './social-scheduler.service';
import { SourcesModule } from '../../sources/sources.module';
import { MentionsModule } from '../../mentions/mentions.module';
import { KeywordsModule } from '../../keywords/keywords.module';

@Module({
  imports: [
    BullModule.registerQueue({ name: SOCIAL_COLLECT_QUEUE }),
    SourcesModule,
    MentionsModule,
    KeywordsModule,
  ],
  providers: [VkService, SocialProcessor, SocialSchedulerService],
  exports: [VkService],
})
export class SocialCollectorModule {}
