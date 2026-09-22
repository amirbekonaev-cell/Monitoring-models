import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CuratedLink } from './curated-link.entity';
import { Mention } from '../mentions/mention.entity';
import { CuratedSearchService } from './curated-search.service';
import { CuratedIngestService } from './curated-ingest.service';
import { CuratedOpenAiReaderService } from './curated-openai-reader.service';
import { CuratedSourceBootstrapService } from './curated-source-bootstrap.service';
import { SourcesModule } from '../sources/sources.module';
import { MentionsModule } from '../mentions/mentions.module';
import { KeywordsModule } from '../keywords/keywords.module';
import { ParserCollectorModule } from '../collectors/parser/parser.module';

/**
 * The closed-pool backend: CuratedSearchService reads it (/search, /status — ПРОМПТ 1),
 * CuratedIngestService fills it (ПРОМПТ 2). Deliberately no @Controller here — `curated_links`
 * and the URLs it carries must never be reachable over HTTP; the Telegram bot reads through
 * CuratedSearchService, and every admin operation on the pool is a CLI script under src/scripts.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([CuratedLink, Mention]),
    SourcesModule,
    MentionsModule,
    KeywordsModule,
    ParserCollectorModule,
  ],
  providers: [CuratedSearchService, CuratedIngestService, CuratedOpenAiReaderService, CuratedSourceBootstrapService],
  exports: [CuratedSearchService, CuratedIngestService, CuratedOpenAiReaderService],
})
export class CuratedModule {}
