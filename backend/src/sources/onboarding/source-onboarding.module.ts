import { Module } from '@nestjs/common';
import { SourceDetectService } from './source-detect.service';
import { SourceOnboardingController } from './source-onboarding.controller';
import { SourcesModule } from '../sources.module';
import { MentionsModule } from '../../mentions/mentions.module';
import { KeywordsModule } from '../../keywords/keywords.module';
import { RssCollectorModule } from '../../collectors/rss/rss.module';
import { TelegramCollectorModule } from '../../collectors/telegram/telegram.module';
import { ParserCollectorModule } from '../../collectors/parser/parser.module';

@Module({
  imports: [
    SourcesModule,
    MentionsModule,
    KeywordsModule,
    RssCollectorModule,
    TelegramCollectorModule,
    ParserCollectorModule,
  ],
  controllers: [SourceOnboardingController],
  providers: [SourceDetectService],
})
export class SourceOnboardingModule {}
