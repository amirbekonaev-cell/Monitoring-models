import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { TELEGRAM_COLLECT_QUEUE, TelegramProcessor } from './telegram.processor';
import { TelegramService } from './telegram.service';
import { TelegramSchedulerService } from './telegram-scheduler.service';
import { SourcesModule } from '../../sources/sources.module';
import { MentionsModule } from '../../mentions/mentions.module';
import { KeywordsModule } from '../../keywords/keywords.module';

@Module({
  imports: [
    BullModule.registerQueue({ name: TELEGRAM_COLLECT_QUEUE }),
    SourcesModule,
    MentionsModule,
    KeywordsModule,
  ],
  providers: [TelegramService, TelegramProcessor, TelegramSchedulerService],
  exports: [TelegramService],
})
export class TelegramCollectorModule {}
