import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { SourceKind } from '../sources/source.entity';
import { SourcesService } from '../sources/sources.service';

/** Idempotent system source for the closed pool — no channel ever polls it, it exists only so
 *  the "Источники" admin list has a normal row (status/last-success) for this "channel" too. */
export const CURATED_SOURCE_URL = 'curated://internal';
export const CURATED_SOURCE_NAME = 'Подборка материалов';

@Injectable()
export class CuratedSourceBootstrapService implements OnModuleInit {
  private readonly logger = new Logger(CuratedSourceBootstrapService.name);

  constructor(private readonly sourcesService: SourcesService) {}

  async onModuleInit(): Promise<void> {
    await this.sourcesService.ensureSingleton({
      url: CURATED_SOURCE_URL,
      name: CURATED_SOURCE_NAME,
      type: SourceKind.CURATED,
    });
    this.logger.log(`Системный источник "${CURATED_SOURCE_NAME}" (${CURATED_SOURCE_URL}) готов`);
  }
}
