import { Module } from '@nestjs/common';
import { OpenAiWebSearchService } from './openai-web-search.service';

@Module({
  providers: [OpenAiWebSearchService],
  exports: [OpenAiWebSearchService],
})
export class SocialSearchCollectorModule {}
