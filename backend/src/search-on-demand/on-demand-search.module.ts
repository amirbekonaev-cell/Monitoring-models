import { Module } from '@nestjs/common';
import { OnDemandSearchService } from './on-demand-search.service';
import { SourcesModule } from '../sources/sources.module';
import { MentionsModule } from '../mentions/mentions.module';
import { KeywordsModule } from '../keywords/keywords.module';
import { RssCollectorModule } from '../collectors/rss/rss.module';
import { ParserCollectorModule } from '../collectors/parser/parser.module';
import { TelegramCollectorModule } from '../collectors/telegram/telegram.module';
import { SearchApiCollectorModule } from '../collectors/search-api/search-api.module';
import { SocialCollectorModule } from '../collectors/social/social.module';
import { SocialSearchCollectorModule } from '../collectors/social-search/social-search.module';

/**
 * Wires the on-demand /search command's combined-channel search to the same collector services
 * every scheduled background job already uses (RssService, ParserService, NewsApiService,
 * TelegramService, VkService, OpenAiWebSearchService) — one shared implementation per channel,
 * just triggered manually instead of by a scheduled background job (there is no scheduled
 * collection any more — see README "Деплой на Vercel").
 */
@Module({
  imports: [
    SourcesModule,
    MentionsModule,
    KeywordsModule,
    RssCollectorModule,
    ParserCollectorModule,
    TelegramCollectorModule,
    SearchApiCollectorModule,
    SocialCollectorModule,
    SocialSearchCollectorModule,
  ],
  providers: [OnDemandSearchService],
  exports: [OnDemandSearchService],
})
export class OnDemandSearchModule {}