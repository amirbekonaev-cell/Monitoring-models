import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { RSS_COLLECT_QUEUE, RssProcessor } from './rss.processor';
import { RssService } from './rss.service';
import { RssSchedulerService } from './rss-scheduler.service';
import { SourcesModule } from '../../sources/sources.module';
import { MentionsModule } from '../../mentions/mentions.module';
import { KeywordsModule } from '../../keywords/keywords.module';

@Module({
  imports: [
    BullModule.registerQueue({ name: RSS_COLLECT_QUEUE }),
    SourcesModule,
    MentionsModule,
    KeywordsModule,
  ],
  providers: [RssService, RssProcessor, RssSchedulerService],
  exports: [RssService],
})
export class RssCollectorModule {}
