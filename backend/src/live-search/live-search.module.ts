import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RssCollectorModule } from '../collectors/rss/rss.module';
import { Setting } from '../settings/setting.entity';
import { LiveRssSearchService } from './live-rss-search.service';
import { OpenAiNewsSearchService } from './openai-news-search.service';
import { LiveFindStoreService } from './live-find-store.service';
import { LiveSearchService } from './live-search.service';

/**
 * Живой поиск внутри /search: RSS-ленты изданий (LiveRssSearchService) и веб-поиск по открытому
 * интернету (OpenAiNewsSearchService), оба — через LiveSearchService, который и запускает их
 * параллельно.
 *
 * САМ ПОИСК из базы не читает ничего: список лент лежит в live-feeds.data.json, формы названия
 * компании — в brand-match.util.ts, сверка с уже показываемыми материалами идёт по JSON. Это
 * сделано нарочно: /search обязан отвечать на стенде без поднятого Postgres.
 *
 * База нужна только LiveFindStoreService — он кладёт находки в таблицу `settings`, чтобы они
 * дожили до нажатия «Да, по одной» (это уже другой вызов вебхука). Любой его сбой гасит
 * TelegramBotService, и выдача уходит человеку как прежде: список заголовков и статьи набора.
 *
 * Веб-поиск требует OPENAI_API_KEY (на деплое он приходит из переменных окружения Vercel), но не
 * требует его НАЛИЧИЯ: без ключа канал просто выключается и остаются ленты — см.
 * OpenAiNewsSearchService.available.
 */
@Module({
  imports: [RssCollectorModule, TypeOrmModule.forFeature([Setting])],
  providers: [LiveRssSearchService, OpenAiNewsSearchService, LiveFindStoreService, LiveSearchService],
  exports: [LiveSearchService, LiveFindStoreService],
})
export class LiveSearchModule {}
