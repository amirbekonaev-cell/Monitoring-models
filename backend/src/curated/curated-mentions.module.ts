import { Module } from '@nestjs/common';
import { CuratedMentionsService } from './curated-mentions.service';

/**
 * Подключите этот модуль в imports любого модуля, которому нужны готовые карточки
 * (например, TelegramBotModule), и инжектируйте CuratedMentionsService.
 */
@Module({
  providers: [CuratedMentionsService],
  exports: [CuratedMentionsService],
})
export class CuratedMentionsModule {}
