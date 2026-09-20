import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CuratedLink } from './curated-link.entity';
import { Mention } from '../mentions/mention.entity';
import { CuratedSearchService } from './curated-search.service';
import { CuratedSourceBootstrapService } from './curated-source-bootstrap.service';
import { SourcesModule } from '../sources/sources.module';

/**
 * The closed-pool /search & /status backend. Deliberately no @Controller here — curated_links
 * (and the URLs it carries) must never be reachable through any HTTP endpoint; the Telegram bot
 * is the only consumer, via CuratedSearchService.
 */
@Module({
  imports: [TypeOrmModule.forFeature([CuratedLink, Mention]), SourcesModule],
  providers: [CuratedSearchService, CuratedSourceBootstrapService],
  exports: [CuratedSearchService],
})
export class CuratedModule {}
