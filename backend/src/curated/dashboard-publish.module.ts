import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Mention } from '../mentions/mention.entity';
import { CuratedMentionsModule } from './curated-mentions.module';
import { DashboardPublishService } from './dashboard-publish.service';

/**
 * Публикация выдачи бота в дашборд и ленту (DashboardPublishService).
 *
 * Отдельный модуль, а не провайдер в CuratedMentionsModule: тот намеренно не зависит ни от
 * TypeORM, ни от БД — именно поэтому /search отвечает мгновенно и работает без базы. Здесь
 * зависимость от БД нужна, и держать её отдельно значит, что обрыв доступа к базе ломает только
 * запись в дашборд, а не ответ бота (см. TelegramBotService: публикация обёрнута в try/catch).
 *
 * Контроллера здесь нет и быть не должно: сбросить или перезаписать всю ленту можно только из
 * бота (кнопка периода) и из CLI-скрипта (npm run dashboard:reset), но не запросом по HTTP.
 */
@Module({
  imports: [TypeOrmModule.forFeature([Mention]), CuratedMentionsModule],
  providers: [DashboardPublishService],
  exports: [DashboardPublishService],
})
export class DashboardPublishModule {}
