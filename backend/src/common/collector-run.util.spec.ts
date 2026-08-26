import { Logger } from '@nestjs/common';
import { runCollectionCycle } from './collector-run.util';
import { SourcesService } from '../sources/sources.service';
import { MentionsService } from '../mentions/mentions.service';
import { KeywordsService, ActiveKeywordSet } from '../keywords/keywords.service';
import { SettingsService } from '../settings/settings.service';
import { SourceKind, SourceStatus } from '../sources/source.entity';
import { MentionSourceType } from '../mentions/mention.entity';

function makeSource(sourceType: SourceKind, lastSuccessAt: Date | null = new Date()) {
  return {
    id: 'src-1',
    url: 'https://example.com',
    name: null,
    type: sourceType,
    status: SourceStatus.ACTIVE,
    lastSuccessAt,
    lastDeepScanAt: null,
    lastError: null,
    createdBy: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function makePassthroughKeywordsService(): KeywordsService {
  const set = { match: jest.fn(async () => ({ matched: true, matchedKeywords: [] })) };
  return { loadActiveKeywordSet: jest.fn(async () => set as unknown as ActiveKeywordSet) } as unknown as KeywordsService;
}

function makePassthroughSettingsService(enabled = true): SettingsService {
  return { isCollectionEnabled: jest.fn(async () => enabled) } as unknown as SettingsService;
}

describe('runCollectionCycle — error messages include the underlying cause', () => {
  it('surfaces error.cause (e.g. TLS/DNS failure behind a generic "fetch failed") in the logged/stored reason', async () => {
    const source = makeSource(SourceKind.PARSER);
    const sourcesService = {
      findActiveByType: jest.fn(async () => [source]),
      markSuccess: jest.fn(async () => undefined),
      markError: jest.fn(async () => undefined),
    } as unknown as SourcesService;
    const fetchError = new Error('fetch failed');
    (fetchError as Error & { cause?: unknown }).cause = new Error('unable to verify the first certificate');

    await runCollectionCycle({
      logger: new Logger('test'),
      channelName: 'Parser',
      sources: [source],
      sourcesService,
      mentionsService: {} as MentionsService,
      keywordsService: makePassthroughKeywordsService(),
      settingsService: makePassthroughSettingsService(),
      sourceType: MentionSourceType.OTHER,
      fetchItems: async () => {
        throw fetchError;
      },
    });

    expect(sourcesService.markError).toHaveBeenCalledWith(
      source.id,
      'fetch failed: unable to verify the first certificate',
    );
  });

  it('falls back to the bare message when there is no cause', async () => {
    const source = makeSource(SourceKind.PARSER);
    const sourcesService = {
      findActiveByType: jest.fn(async () => [source]),
      markSuccess: jest.fn(async () => undefined),
      markError: jest.fn(async () => undefined),
    } as unknown as SourcesService;

    await runCollectionCycle({
      logger: new Logger('test'),
      channelName: 'Parser',
      sources: [source],
      sourcesService,
      mentionsService: {} as MentionsService,
      keywordsService: makePassthroughKeywordsService(),
      settingsService: makePassthroughSettingsService(),
      sourceType: MentionSourceType.OTHER,
      fetchItems: async () => {
        throw new Error('HTTP 404');
      },
    });

    expect(sourcesService.markError).toHaveBeenCalledWith(source.id, 'HTTP 404');
  });
});

describe('runCollectionCycle — BACKFILL_DAYS window', () => {
  const originalEnv = process.env.BACKFILL_DAYS;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.BACKFILL_DAYS;
    } else {
      process.env.BACKFILL_DAYS = originalEnv;
    }
  });

  function daysAgo(days: number): Date {
    return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  }

  it('defaults to 60 days when BACKFILL_DAYS is unset: skips an item older than that, keeps a recent one', async () => {
    delete process.env.BACKFILL_DAYS;
    const source = makeSource(SourceKind.RSS, null); // lastSuccessAt: null -> this cycle is backfill
    const mentionsService = { createIfNew: jest.fn(async () => 'inserted') } as unknown as MentionsService;
    const sourcesService = {
      findActiveByType: jest.fn(async () => [source]),
      markSuccess: jest.fn(async () => undefined),
      markError: jest.fn(async () => undefined),
    } as unknown as SourcesService;

    const summary = await runCollectionCycle({
      logger: new Logger('test'),
      channelName: 'RSS',
      sources: [source],
      sourcesService,
      mentionsService,
      keywordsService: makePassthroughKeywordsService(),
      settingsService: makePassthroughSettingsService(),
      sourceType: MentionSourceType.NEWS,
      fetchItems: async () => [
        { title: 'old', text: '', url: 'https://example.com/old', publishedAt: daysAgo(90), hash: 'h-old' },
        { title: 'recent', text: '', url: 'https://example.com/recent', publishedAt: daysAgo(10), hash: 'h-new' },
      ],
    });

    expect(summary.itemsSkippedOldBackfill).toBe(1);
    expect(mentionsService.createIfNew).toHaveBeenCalledTimes(1);
    expect(mentionsService.createIfNew).toHaveBeenCalledWith(expect.objectContaining({ hash: 'h-new' }));
  });

  it('honours a custom BACKFILL_DAYS value', async () => {
    process.env.BACKFILL_DAYS = '7';
    const source = makeSource(SourceKind.RSS, null);
    const mentionsService = { createIfNew: jest.fn(async () => 'inserted') } as unknown as MentionsService;
    const sourcesService = {
      findActiveByType: jest.fn(async () => [source]),
      markSuccess: jest.fn(async () => undefined),
      markError: jest.fn(async () => undefined),
    } as unknown as SourcesService;

    const summary = await runCollectionCycle({
      logger: new Logger('test'),
      channelName: 'RSS',
      sources: [source],
      sourcesService,
      mentionsService,
      keywordsService: makePassthroughKeywordsService(),
      settingsService: makePassthroughSettingsService(),
      sourceType: MentionSourceType.NEWS,
      fetchItems: async () => [
        { title: 'ten days ago', text: '', url: 'https://example.com/a', publishedAt: daysAgo(10), hash: 'h1' },
      ],
    });

    expect(summary.itemsSkippedOldBackfill).toBe(1);
    expect(mentionsService.createIfNew).not.toHaveBeenCalled();
  });

  it('never applies the cutoff outside a backfill cycle (source already has a lastSuccessAt)', async () => {
    const source = makeSource(SourceKind.RSS, new Date()); // not backfill
    const mentionsService = { createIfNew: jest.fn(async () => 'inserted') } as unknown as MentionsService;
    const sourcesService = {
      findActiveByType: jest.fn(async () => [source]),
      markSuccess: jest.fn(async () => undefined),
      markError: jest.fn(async () => undefined),
    } as unknown as SourcesService;

    const summary = await runCollectionCycle({
      logger: new Logger('test'),
      channelName: 'RSS',
      sources: [source],
      sourcesService,
      mentionsService,
      keywordsService: makePassthroughKeywordsService(),
      settingsService: makePassthroughSettingsService(),
      sourceType: MentionSourceType.NEWS,
      fetchItems: async () => [
        { title: 'ancient', text: '', url: 'https://example.com/a', publishedAt: daysAgo(400), hash: 'h1' },
      ],
    });

    expect(summary.itemsSkippedOldBackfill).toBe(0);
    expect(mentionsService.createIfNew).toHaveBeenCalledTimes(1);
  });

  it('does not skip items with an unknown publish date, even during backfill (best-effort only)', async () => {
    const source = makeSource(SourceKind.PARSER, null);
    const mentionsService = { createIfNew: jest.fn(async () => 'inserted') } as unknown as MentionsService;
    const sourcesService = {
      findActiveByType: jest.fn(async () => [source]),
      markSuccess: jest.fn(async () => undefined),
      markError: jest.fn(async () => undefined),
    } as unknown as SourcesService;

    const summary = await runCollectionCycle({
      logger: new Logger('test'),
      channelName: 'Parser',
      sources: [source],
      sourcesService,
      mentionsService,
      keywordsService: makePassthroughKeywordsService(),
      settingsService: makePassthroughSettingsService(),
      sourceType: MentionSourceType.OTHER,
      fetchItems: async () => [
        { title: 'no date', text: '', url: 'https://example.com/a', publishedAt: null, hash: 'h1' },
      ],
    });

    expect(summary.itemsSkippedOldBackfill).toBe(0);
    expect(mentionsService.createIfNew).toHaveBeenCalledTimes(1);
  });
});

describe('runCollectionCycle — skipDedup passthrough (К-6 web search never dedups)', () => {
  it('forwards skipDedup: true to createIfNew when the caller sets it', async () => {
    const source = makeSource(SourceKind.SOCIAL_SEARCH_API);
    const mentionsService = { createIfNew: jest.fn(async () => 'inserted') } as unknown as MentionsService;
    const sourcesService = {
      findActiveByType: jest.fn(async () => [source]),
      markSuccess: jest.fn(async () => undefined),
      markError: jest.fn(async () => undefined),
    } as unknown as SourcesService;

    await runCollectionCycle({
      logger: new Logger('test'),
      channelName: 'Social search',
      sources: [source],
      sourcesService,
      mentionsService,
      keywordsService: makePassthroughKeywordsService(),
      settingsService: makePassthroughSettingsService(),
      sourceType: MentionSourceType.SOCIAL_SEARCH,
      fetchItems: async () => [{ title: 't', text: 'x', url: 'https://example.com/a', publishedAt: null, hash: 'h' }],
      skipDedup: true,
    });

    expect(mentionsService.createIfNew).toHaveBeenCalledWith(expect.objectContaining({ skipDedup: true }));
  });

  it('does not set skipDedup when the caller omits it (every other channel)', async () => {
    const source = makeSource(SourceKind.RSS);
    const mentionsService = { createIfNew: jest.fn(async () => 'inserted') } as unknown as MentionsService;
    const sourcesService = {
      findActiveByType: jest.fn(async () => [source]),
      markSuccess: jest.fn(async () => undefined),
      markError: jest.fn(async () => undefined),
    } as unknown as SourcesService;

    await runCollectionCycle({
      logger: new Logger('test'),
      channelName: 'RSS',
      sources: [source],
      sourcesService,
      mentionsService,
      keywordsService: makePassthroughKeywordsService(),
      settingsService: makePassthroughSettingsService(),
      sourceType: MentionSourceType.NEWS,
      fetchItems: async () => [{ title: 't', text: 'x', url: 'https://example.com/a', publishedAt: null, hash: 'h' }],
    });

    expect(mentionsService.createIfNew).toHaveBeenCalledWith(expect.objectContaining({ skipDedup: undefined }));
  });
});

describe('runCollectionCycle — global collection_enabled pause (/pause, /resume)', () => {
  it('does nothing and reports paused:true when collection is disabled — no fetch, no source status touched', async () => {
    const source = makeSource(SourceKind.RSS);
    const fetchItems = jest.fn();
    const sourcesService = {
      findActiveByType: jest.fn(async () => [source]),
      markSuccess: jest.fn(async () => undefined),
      markError: jest.fn(async () => undefined),
    } as unknown as SourcesService;
    const mentionsService = { createIfNew: jest.fn() } as unknown as MentionsService;

    const summary = await runCollectionCycle({
      logger: new Logger('test'),
      channelName: 'RSS',
      sources: [source],
      sourcesService,
      mentionsService,
      keywordsService: makePassthroughKeywordsService(),
      settingsService: makePassthroughSettingsService(false),
      sourceType: MentionSourceType.NEWS,
      fetchItems,
    });

    expect(summary.paused).toBe(true);
    expect(fetchItems).not.toHaveBeenCalled();
    expect(sourcesService.markSuccess).not.toHaveBeenCalled();
    expect(sourcesService.markError).not.toHaveBeenCalled();
    expect(mentionsService.createIfNew).not.toHaveBeenCalled();
  });

  it('runs normally and reports paused:false when collection is enabled', async () => {
    const source = makeSource(SourceKind.RSS);
    const sourcesService = {
      findActiveByType: jest.fn(async () => [source]),
      markSuccess: jest.fn(async () => undefined),
      markError: jest.fn(async () => undefined),
    } as unknown as SourcesService;
    const mentionsService = { createIfNew: jest.fn(async () => 'inserted') } as unknown as MentionsService;

    const summary = await runCollectionCycle({
      logger: new Logger('test'),
      channelName: 'RSS',
      sources: [source],
      sourcesService,
      mentionsService,
      keywordsService: makePassthroughKeywordsService(),
      settingsService: makePassthroughSettingsService(true),
      sourceType: MentionSourceType.NEWS,
      fetchItems: async () => [{ title: 't', text: 'x', url: 'https://example.com/a', publishedAt: null, hash: 'h' }],
    });

    expect(summary.paused).toBe(false);
    expect(sourcesService.markSuccess).toHaveBeenCalledWith(source.id);
  });
});