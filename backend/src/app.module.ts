import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import configuration from './config/configuration';
import { Source } from './sources/source.entity';
import { Mention } from './mentions/mention.entity';
import { Keyword } from './keywords/keyword.entity';
import { SourcesModule } from './sources/sources.module';
import { MentionsModule } from './mentions/mentions.module';
import { KeywordsModule } from './keywords/keywords.module';
import { QueueModule } from './queue/queue.module';
import { RssCollectorModule } from './collectors/rss/rss.module';
import { ParserCollectorModule } from './collectors/parser/parser.module';
import { TelegramCollectorModule } from './collectors/telegram/telegram.module';
import { SearchApiCollectorModule } from './collectors/search-api/search-api.module';
import { SocialCollectorModule } from './collectors/social/social.module';
import { SourceOnboardingModule } from './sources/onboarding/source-onboarding.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [configuration] }),
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
        entities: [Source, Mention, Keyword],
        synchronize: false,
      }),
    }),
    QueueModule,
    SourcesModule,
    MentionsModule,
    KeywordsModule,
    RssCollectorModule,
    ParserCollectorModule,
    TelegramCollectorModule,
    SearchApiCollectorModule,
    SocialCollectorModule,
    SourceOnboardingModule,
  ],
})
export class AppModule {}
