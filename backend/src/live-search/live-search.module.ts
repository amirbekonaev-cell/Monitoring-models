import { Module } from '@nestjs/common';
import { RssCollectorModule } from '../collectors/rss/rss.module';
import { LiveRssSearchService } from './live-rss-search.service';

/**
 * Живой проход по RSS-лентам внутри /search (см. LiveRssSearchService).
 *
 * Зависимость одна — RssService, то есть разбор фида, и ничего больше: ни репозиториев, ни
 * SourcesService, ни OpenAI. Это сделано нарочно и проверяется тестом: /search обязан отвечать на
 * стенде без поднятой базы и без OPENAI_API_KEY, и подключение этого модуля к боту не вправе это
 * сломать. Список лент лежит рядом, в live-feeds.data.json.
 */
@Module({
  imports: [RssCollectorModule],
  providers: [LiveRssSearchService],
  exports: [LiveRssSearchService],
})
export class LiveSearchModule {}
