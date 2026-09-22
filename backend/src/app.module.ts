import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import configuration from './config/configuration';
import { CommonModule } from './common/common.module';
import { MentionPrivacyInterceptor } from './common/mention-privacy.interceptor';
import { Source } from './sources/source.entity';
import { Mention } from './mentions/mention.entity';
import { Keyword } from './keywords/keyword.entity';
import { Setting } from './settings/setting.entity';
import { CuratedLink } from './curated/curated-link.entity';
import { SourcesModule } from './sources/sources.module';
import { MentionsModule } from './mentions/mentions.module';
import { KeywordsModule } from './keywords/keywords.module';
import { SettingsModule } from './settings/settings.module';
import { RssCollectorModule } from './collectors/rss/rss.module';
import { ParserCollectorModule } from './collectors/parser/parser.module';
import { TelegramCollectorModule } from './collectors/telegram/telegram.module';
import { SearchApiCollectorModule } from './collectors/search-api/search-api.module';
import { SocialCollectorModule } from './collectors/social/social.module';
import { SocialSearchCollectorModule } from './collectors/social-search/social-search.module';
import { SourceOnboardingModule } from './sources/onboarding/source-onboarding.module';
import { TelegramBotModule } from './notifications/telegram/telegram-bot.module';
import { SentimentModule } from './sentiment/sentiment.module';
import { CuratedModule } from './curated/curated.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [configuration] }),
    CommonModule,
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres',
        host: config.get<string>('db.host'),
        port: config.get<number>('db.port'),
        username: config.get<string>('db.username'),
        password: config.get<string>('db.password'),
        database: config.get<string>('db.database'),
        ssl: config.get('db.ssl'),
        entities: [Source, Mention, Keyword, Setting, CuratedLink],
        synchronize: false,
      }),
    }),
    SourcesModule,
    MentionsModule,
    KeywordsModule,
    SettingsModule,
    RssCollectorModule,
    ParserCollectorModule,
    TelegramCollectorModule,
    SearchApiCollectorModule,
    SocialCollectorModule,
    SocialSearchCollectorModule,
    SourceOnboardingModule,
    SentimentModule,
    CuratedModule,
    TelegramBotModule,
  ],
  providers: [
    // Global, not per-controller: hidden pool URLs must be stripped from EVERY response that
    // serializes a mention, including endpoints added later — see mention-privacy.util.ts for
    // why this cannot live in the frontend.
    { provide: APP_INTERCEPTOR, useClass: MentionPrivacyInterceptor },
  ],
})
export class AppModule {}
