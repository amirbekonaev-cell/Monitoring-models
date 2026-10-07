import { Module } from '@nestjs/common';
import { CuratedMentionsService } from './curated-mentions.service';
import { CuratedJsonSearchService } from './curated-json-search.service';
import { CURATED_SEARCH_SOURCE } from './curated-search.types';

/**
 * Подключите этот модуль в imports любого модуля, которому нужны готовые карточки
 * (например, TelegramBotModule), и инжектируйте CuratedMentionsService.
 *
 * Здесь же живёт CuratedJsonSearchService — реализация CuratedSearchSource поверх тех же карточек,
 * привязанная к токену CURATED_SEARCH_SOURCE. Именно её получает Telegram-бот для /search и
 * /status: ни БД, ни сети, ни OpenAI в этом пути нет, поэтому модуль не зависит ни от TypeORM, ни
 * от CuratedModule.
 */
@Module({
  providers: [
    CuratedMentionsService,
    CuratedJsonSearchService,
    { provide: CURATED_SEARCH_SOURCE, useExisting: CuratedJsonSearchService },
  ],
  exports: [CuratedMentionsService, CuratedJsonSearchService, CURATED_SEARCH_SOURCE],
})
export class CuratedMentionsModule {}
