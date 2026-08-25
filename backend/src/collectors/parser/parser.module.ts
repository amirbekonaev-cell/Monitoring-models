import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { PARSER_COLLECT_QUEUE, ParserProcessor } from './parser.processor';
import { ParserService } from './parser.service';
import { ParserSchedulerService } from './parser-scheduler.service';
import { SourcesModule } from '../../sources/sources.module';
import { MentionsModule } from '../../mentions/mentions.module';
import { KeywordsModule } from '../../keywords/keywords.module';

@Module({
  imports: [
    BullModule.registerQueue({ name: PARSER_COLLECT_QUEUE }),
    SourcesModule,
    MentionsModule,
    KeywordsModule,
  ],
  providers: [ParserService, ParserProcessor, ParserSchedulerService],
  exports: [ParserService],
})
export class ParserCollectorModule {}
