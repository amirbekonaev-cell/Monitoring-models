import { Module } from '@nestjs/common';
import { TelegramNotifierService } from './telegram-notifier.service';
import { TelegramBotService } from './telegram-bot.service';
import { TelegramWebhookController } from './telegram-webhook.controller';
import { CuratedModule } from '../../curated/curated.module';
import { CuratedMentionsModule } from '../../curated/curated-mentions.module';
import { DashboardPublishModule } from '../../curated/dashboard-publish.module';

@Module({
  // CuratedModule — закрытый пул ссылок (/status, /search). CuratedMentionsModule — вручную
  // проверенные карточки (/curated_stats, /curated <издание>). Разные наборы данных и разные
  // команды, несмотря на похожие имена.
  // DashboardPublishModule — перенос выдачи /search в дашборд и ленту веб-интерфейса.
  imports: [CuratedModule, CuratedMentionsModule, DashboardPublishModule],
  controllers: [TelegramWebhookController],
  providers: [TelegramNotifierService, TelegramBotService],
  exports: [TelegramNotifierService, TelegramBotService],
})
export class TelegramBotModule {}
