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
    // Best-effort, not load-bearing: this row only makes the "Источники" admin list show a
    // normal entry for the curated pool "channel" — nothing that actually serves /status or
    // /search (CuratedSearchService) touches it. On Vercel this runs on EVERY cold start (the
    // deploy boots a fresh Nest app per invocation, see README "Деплой на Vercel"), so a
    // transient hiccup from a managed Postgres that just woke up from its own idle scale-down
    // (Neon/Supabase) is routine here, not exceptional. Left unguarded, that one failed SELECT
    // used to throw out of onModuleInit(), which NestJS never catches on its own — it crashed
    // the whole process before the update even reached TelegramBotService, and Telegram saw a
    // bare 500 with the actual command or button click simply lost (found live: a webhook crash
    // logged at the exact second a /search button click went unanswered).
    try {
      await this.sourcesService.ensureSingleton({
        url: CURATED_SOURCE_URL,
        name: CURATED_SOURCE_NAME,
        type: SourceKind.CURATED,
      });
      this.logger.log(`Системный источник "${CURATED_SOURCE_NAME}" (${CURATED_SOURCE_URL}) готов`);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `Не удалось создать/найти системный источник "${CURATED_SOURCE_NAME}" (не критично — ` +
          `влияет только на список "Источники" в админке, не на /status и /search): ${reason}`,
      );
    }
  }
}
