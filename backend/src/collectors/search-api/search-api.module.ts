import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { SEARCH_API_COLLECT_QUEUE, SearchApiProcessor } from './search-api.processor';
import { NewsApiService } from './newsapi.service';
import { SearchApiSchedulerService } from './search-api-scheduler.service';
import { SourcesModule } from '../../sources/sources.module';
import { MentionsModule } from '../../mentions/mentions.module';
import { KeywordsModule } from '../../keywords/keywords.module';

@Module({
  imports: [
    BullModule.registerQueue({ name: SEARCH_API_COLLECT_QUEUE }),
    SourcesModule,
    MentionsModule,
    KeywordsModule,
  ],
  providers: [NewsApiService, SearchApiProcessor, SearchApiSchedulerService],
  exports: [NewsApiService],
})
export class SearchApiCollectorModule {}
