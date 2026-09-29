import { Test } from '@nestjs/testing';
import { CuratedSourceBootstrapService, CURATED_SOURCE_NAME, CURATED_SOURCE_URL } from './curated-source-bootstrap.service';
import { SourcesService } from '../sources/sources.service';
import { SourceKind } from '../sources/source.entity';

describe('CuratedSourceBootstrapService', () => {
  it('creates/finds the curated system source on init', async () => {
    const ensureSingleton = jest.fn(async () => ({}) as any);
    const moduleRef = await Test.createTestingModule({
      providers: [CuratedSourceBootstrapService, { provide: SourcesService, useValue: { ensureSingleton } }],
    }).compile();

    const service = moduleRef.get(CuratedSourceBootstrapService);
    await service.onModuleInit();

    expect(ensureSingleton).toHaveBeenCalledWith({
      url: CURATED_SOURCE_URL,
      name: CURATED_SOURCE_NAME,
      type: SourceKind.CURATED,
    });
  });

  // Regression: on Vercel this runs on EVERY cold start (fresh Nest app per invocation), so a
  // managed Postgres waking from its own idle scale-down is routine, not exceptional. Before this
  // fix, a failed SELECT here threw out of onModuleInit() uncaught, which crashed the whole
  // process before the incoming Telegram update (command or button click) ever reached
  // TelegramBotService — found live via a "Connection terminated unexpectedly" crash logged at
  // the exact second a /search button click went unanswered.
  it('does not throw when the DB call fails — this row is cosmetic (admin "Источники" list only), never load-bearing for /status or /search', async () => {
    const ensureSingleton = jest.fn(async () => {
      throw new Error('Connection terminated unexpectedly');
    });
    const moduleRef = await Test.createTestingModule({
      providers: [CuratedSourceBootstrapService, { provide: SourcesService, useValue: { ensureSingleton } }],
    }).compile();

    const service = moduleRef.get(CuratedSourceBootstrapService);

    await expect(service.onModuleInit()).resolves.toBeUndefined();
    expect(ensureSingleton).toHaveBeenCalledTimes(1);
  });
});
