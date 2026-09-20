import { Module } from '@nestjs/common';
import { TelegramNotifierService } from './telegram-notifier.service';
import { TelegramBotService } from './telegram-bot.service';
import { TelegramWebhookController } from './telegram-webhook.controller';
import { CuratedModule } from '../../curated/curated.module';

@Module({
  imports: [CuratedModule],
  controllers: [TelegramWebhookController],
  providers: [TelegramNotifierService, TelegramBotService],
  exports: [TelegramNotifierService, TelegramBotService],
})
export class TelegramBotModule {}
