import { Module } from '@nestjs/common';
import { RssCollectorModule } from '../collectors/rss/rss.module';
import { LiveRssSearchService } from './live-rss-search.service';
import { OpenAiNewsSearchService } from './openai-news-search.service';
import { LiveSearchService } from './live-search.service';

/**
 * Живой поиск внутри /search: RSS-ленты изданий (LiveRssSearchService) и веб-поиск по открытому
 * интернету (OpenAiNewsSearchService), оба — через LiveSearchService, который и запускает их
 * параллельно.
 *
 * Из базы здесь не читается ничего: список лент лежит в live-feeds.data.json, формы названия
 * компании — в brand-match.util.ts, сверка с уже показываемыми материалами идёт по JSON. Это
 * сделано нарочно: /search обязан отвечать на стенде без поднятого Postgres.
 *
 * Веб-поиск требует OPENAI_API_KEY (на деплое он приходит из переменных окружения Vercel), но не
 * требует его НАЛИЧИЯ: без ключа канал просто выключается и остаются ленты — см.
 * OpenAiNewsSearchService.available.
 */
@Module({
  imports: [RssCollectorModule],
  providers: [LiveRssSearchService, OpenAiNewsSearchService, LiveSearchService],
  exports: [LiveSearchService],
})
export class LiveSearchModule {}
