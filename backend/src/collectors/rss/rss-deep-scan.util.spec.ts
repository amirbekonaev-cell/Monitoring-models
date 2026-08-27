import { Logger } from '@nestjs/common';
import { fetchRssWithDeepScan } from './rss-deep-scan.util';
import { RssService } from './rss.service';
import { ParserService } from '../parser/parser.service';
import { SourcesService } from '../../sources/sources.service';
import { Source, SourceKind, SourceStatus } from '../../sources/source.entity';
import { CollectedItem } from '../../common/collector-run.util';

function makeSource(overrides: Partial<Source> = {}): Source {
  return {
    id: 'src-1',
    url: 'https://news.example/rss',
    name: null,
    type: SourceKind.RSS,
    status: SourceStatus.ACTIVE,
    lastSuccessAt: new Date(),
    lastDeepScanAt: new Date(),
    lastError: null,
    createdBy: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function item(overrides: Partial<CollectedItem> = {}): CollectedItem {
  return { title: 't', text: 'x', url: 'https://news.example/a', publishedAt: null, hash: 'h', ...overrides };
}

function makeParserService(deepItems: CollectedItem[] = [], deepCollectImpl?: jest.Mock) {
  return {
    deepCollect: deepCollectImpl ?? jest.fn(async () => ({ items: deepItems, strategy: 'sitemap' })),
    getBackfillMaxPages: jest.fn(() => 25),
    getDefaultMaxPages: jest.fn(() => 5),
  } as unknown as ParserService;
}

function makeSourcesService() {
  return { markDeepScanDone: jest.fn(async () => undefined) } as unknown as SourcesService;
}

describe('fetchRssWithDeepScan', () => {
  it('skips the deep pass entirely when the source was scanned recently (not first run, not due yet)', async () => {
    const source = makeSource({ lastSuccessAt: new Date(), lastDeepScanAt: new Date() });
    const rssService = { fetchFeed: jest.fn(async () => [item({ hash: 'rss-1' })]) } as unknown as RssService;
    const parserService = makeParserService();
    const sourcesService = makeSourcesService();

    const items = await fetchRssWithDeepScan({ source, logger: new Logger('test'), rssService, parserService, sourcesService });

    expect(items).toEqual([item({ hash: 'rss-1' })]);
    expect(parserService.deepCollect).not.toHaveBeenCalled();
    expect(sourcesService.markDeepScanDone).not.toHaveBeenCalled();
  });

  it('runs the full BACKFILL_DAYS deep pass on a source\'s first-ever cycle (lastSuccessAt === null), even if lastDeepScanAt looks recent', async () => {
    const source = makeSource({ lastSuccessAt: null, lastDeepScanAt: null });
    const rssService = { fetchFeed: jest.fn(async () => [item({ hash: 'rss-1', url: 'https://news.example/a' })]) } as unknown as RssService;
    const parserService = makeParserService([item({ hash: 'deep-1', url: 'https://news.example/older-article' })]);
    const sourcesService = makeSourcesService();

    const items = await fetchRssWithDeepScan({ source, logger: new Logger('test'), rssService, parserService, sourcesService });

    expect(parserService.deepCollect).toHaveBeenCalledTimes(1);
    expect(parserService.getBackfillMaxPages).toHaveBeenCalled();
    expect(items.map((i) => i.url)).toEqual(['https://news.example/a', 'https://news.example/older-article']);
    expect(sourcesService.markDeepScanDone).toHaveBeenCalledWith('src-1');
  });

  it('gives an already-onboarded source the full BACKFILL_DAYS window on its first-ever deep pass, not the short routine one — even though lastSuccessAt is long set', async () => {
    // This is exactly the state every pre-existing RSS source is in right after this feature
    // ships: the migration adds last_deep_scan_at as NULL for all of them, but last_success_at
    // has been set for months. Getting only the short lookback here would mean the deep pass
    // never actually reaches back through the RSS feed's blind spot for any source that already
    // existed before this feature — see CLAUDE.md task diagnostics.
    const source = makeSource({ lastSuccessAt: new Date('2026-01-01'), lastDeepScanAt: null });
    const rssService = { fetchFeed: jest.fn(async () => []) } as unknown as RssService;
    const parserService = makeParserService([item({ hash: 'deep-1', url: 'https://news.example/old-backlog-article' })]);
    const sourcesService = makeSourcesService();

    const items = await fetchRssWithDeepScan({ source, logger: new Logger('test'), rssService, parserService, sourcesService });

    expect(parserService.getBackfillMaxPages).toHaveBeenCalled();
    expect(parserService.getDefaultMaxPages).not.toHaveBeenCalled();
    expect(items.map((i) => i.url)).toEqual(['https://news.example/old-backlog-article']);
  });

  it('runs a routine (shorter-lookback) deep pass once the throttle interval has elapsed on an already-onboarded source', async () => {
    const source = makeSource({
      lastSuccessAt: new Date(),
      lastDeepScanAt: new Date(Date.now() - 48 * 60 * 60 * 1000), // 48h ago > 24h default throttle
    });
    const rssService = { fetchFeed: jest.fn(async () => []) } as unknown as RssService;
    const parserService = makeParserService([item({ hash: 'deep-2', url: 'https://news.example/caught-up' })]);
    const sourcesService = makeSourcesService();

    const items = await fetchRssWithDeepScan({ source, logger: new Logger('test'), rssService, parserService, sourcesService });

    expect(parserService.deepCollect).toHaveBeenCalledTimes(1);
    expect(parserService.getDefaultMaxPages).toHaveBeenCalled();
    expect(items.map((i) => i.url)).toEqual(['https://news.example/caught-up']);
  });

  it('deduplicates by URL when the deep pass rediscovers an article the RSS feed already returned', async () => {
    const source = makeSource({ lastSuccessAt: null, lastDeepScanAt: null });
    const rssService = {
      fetchFeed: jest.fn(async () => [item({ hash: 'rss-1', url: 'https://news.example/same' })]),
    } as unknown as RssService;
    const parserService = makeParserService([item({ hash: 'deep-1', url: 'https://news.example/same' })]);
    const sourcesService = makeSourcesService();

    const items = await fetchRssWithDeepScan({ source, logger: new Logger('test'), rssService, parserService, sourcesService });

    expect(items).toHaveLength(1);
  });

  it('isolates a failing deep pass: still returns the RSS items, does not mark the scan done, and does not throw', async () => {
    const source = makeSource({ lastSuccessAt: null, lastDeepScanAt: null });
    const rssService = { fetchFeed: jest.fn(async () => [item({ hash: 'rss-1' })]) } as unknown as RssService;
    const parserService = makeParserService(
      [],
      jest.fn(async () => {
        throw new Error('sitemap host unreachable');
      }),
    );
    const sourcesService = makeSourcesService();

    const items = await fetchRssWithDeepScan({ source, logger: new Logger('test'), rssService, parserService, sourcesService });

    expect(items).toEqual([item({ hash: 'rss-1' })]);
    expect(sourcesService.markDeepScanDone).not.toHaveBeenCalled();
  });

  it('propagates an RSS feed failure as-is (the fast path failing is a real source error, not something to swallow)', async () => {
    const source = makeSource();
    const rssService = {
      fetchFeed: jest.fn(async () => {
        throw new Error('feed unreachable');
      }),
    } as unknown as RssService;
    const parserService = makeParserService();
    const sourcesService = makeSourcesService();

    await expect(
      fetchRssWithDeepScan({ source, logger: new Logger('test'), rssService, parserService, sourcesService }),
    ).rejects.toThrow('feed unreachable');
  });
});
