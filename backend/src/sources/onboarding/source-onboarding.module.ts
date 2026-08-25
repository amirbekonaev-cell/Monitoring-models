import { Module } from '@nestjs/common';
import { SourceDetectService } from './source-detect.service';
import { SourceOnboardingService } from './source-onboarding.service';
import { SourceOnboardingController } from './source-onboarding.controller';
import { SourcesModule } from '../sources.module';
import { MentionsModule } from '../../mentions/mentions.module';
import { KeywordsModule } from '../../keywords/keywords.module';
import { SettingsModule } from '../../settings/settings.module';
import { RssCollectorModule } from '../../collectors/rss/rss.module';
import { TelegramCollectorModule } from '../../collectors/telegram/telegram.module';
import { ParserCollectorModule } from '../../collectors/parser/parser.module';
import { CommonModule } from '../../common/common.module';

@Module({
  imports: [
    SourcesModule,
    MentionsModule,
    KeywordsModule,
    SettingsModule,
    CommonModule,
    RssCollectorModule,
    TelegramCollectorModule,
    ParserCollectorModule,
  ],
  controllers: [SourceOnboardingController],
  providers: [SourceDetectService, SourceOnboardingService],
  exports: [SourceOnboardingService],
})
export class SourceOnboardingModule {}
