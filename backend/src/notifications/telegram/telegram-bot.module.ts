import { Module } from '@nestjs/common';
import { TelegramNotifierService } from './telegram-notifier.service';
import { TelegramBotService } from './telegram-bot.service';
import { TelegramWebhookController } from './telegram-webhook.controller';
import { MentionsModule } from '../../mentions/mentions.module';
import { SourcesModule } from '../../sources/sources.module';
import { SettingsModule } from '../../settings/settings.module';
import { OnDemandSearchModule } from '../../search-on-demand/on-demand-search.module';

@Module({
  imports: [MentionsModule, SourcesModule, SettingsModule, OnDemandSearchModule],
  controllers: [TelegramWebhookController],
  providers: [TelegramNotifierService, TelegramBotService],
  exports: [TelegramNotifierService, TelegramBotService],
})
export class TelegramBotModule {}
