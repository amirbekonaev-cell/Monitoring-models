import { Logger } from '@nestjs/common';
import { fetchParserWithDeepScan, describeParserDeepScanNote } from './parser-deep-scan.util';
import { ParserService, ParserDeepScanOutcome } from './parser.service';
import { SourcesService } from '../../sources/sources.service';
import { Source, SourceKind, SourceStatus } from '../../sources/source.entity';
import { CollectedItem } from '../../common/collector-run.util';

function makeSource(overrides: Partial<Source> = {}): Source {
  return {
    id: 'src-1',
    url: 'https://news.example/',
    name: null,
    type: SourceKind.PARSER,
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

function makeParserService(outcome: ParserDeepScanOutcome = { items: [], strategy: 'none' }, deepCollectImpl?: jest.Mock) {
  return {
    deepCollect: deepCollectImpl ?? jest.fn(async () => outcome),
    getBackfillMaxPages: jest.fn(() => 25),
    getDefaultMaxPages: jest.fn(() => 5),
  } as unknown as ParserService;
}

function makeSourcesService() {
  return { markDeepScanDone: jest.fn(async () => undefined) } as unknown as SourcesService;
}

const budget = { deadline: Date.now() + 30_000 };

describe('fetchParserWithDeepScan', () => {
  it('skips the deep pass entirely (returns empty, strategy "skipped") when the source was scanned recently — a PARSER source has no fast/feed path to fall back to', async () => {
    const source = makeSource({ lastSuccessAt: new Date(), lastDeepScanAt: new Date() });
    const parserService = makeParserService();
    const sourcesService = makeSourcesService();

    const result = await fetchParserWithDeepScan({ source, logger: new Logger('test'), parserService, sourcesService, budget });

    expect(result).toEqual({ items: [], strategy: 'skipped' });
    expect(parserService.deepCollect).not.toHaveBeenCalled();
    expect(sourcesService.markDeepScanDone).not.toHaveBeenCalled();
  });

  it("runs the full BACKFILL_DAYS deep pass on a source's first-ever cycle (lastSuccessAt === null), even if lastDeepScanAt looks recent", async () => {
    const source = makeSource({ lastSuccessAt: null, lastDeepScanAt: null });
    const found = [item({ hash: 'deep-1', url: 'https://news.example/older-article' })];
    const parserService = makeParserService({ items: found, strategy: 'sitemap' });
    const sourcesService = makeSourcesService();

    const result = await fetchParserWithDeepScan({ source, logger: new Logger('test'), parserService, sourcesService, budget });

    expect(parserService.deepCollect).toHaveBeenCalledTimes(1);
    expect(parserService.getBackfillMaxPages).toHaveBeenCalled();
    expect(result).toEqual({ items: found, strategy: 'sitemap' });
    expect(sourcesService.markDeepScanDone).toHaveBeenCalledWith('src-1');
  });

  it('gives an already-onboarded source the full BACKFILL_DAYS window on its first-ever deep pass, not the short routine one — even though lastSuccessAt is long set', async () => {
    // Every PARSER source that existed before this feature shipped is in exactly this state: the
    // migration adds last_deep_scan_at as NULL for all of them, but last_success_at has been set
    // for a while (from the old fetchPage()-only path). That first deep pass deserves the full
    // backfill window too — see CLAUDE.md task diagnostics (this is exactly sknews.kz's situation).
    const source = makeSource({ lastSuccessAt: new Date('2026-01-01'), lastDeepScanAt: null });
    const found = [item({ hash: 'deep-1', url: 'https://news.example/old-backlog-article' })];
    const parserService = makeParserService({ items: found, strategy: 'html-pagination' });
    const sourcesService = makeSourcesService();

    const result = await fetchParserWithDeepScan({ source, logger: new Logger('test'), parserService, sourcesService, budget });

    expect(parserService.getBackfillMaxPages).toHaveBeenCalled();
    expect(parserService.getDefaultMaxPages).not.toHaveBeenCalled();
    expect(result).toEqual({ items: found, strategy: 'html-pagination' });
  });

  it('runs a routine (shorter-lookback) deep pass once the throttle interval has elapsed on an already-onboarded source', async () => {
    const source = makeSource({
      lastSuccessAt: new Date(),
      lastDeepScanAt: new Date(Date.now() - 48 * 60 * 60 * 1000), // 48h ago > 24h default throttle
    });
    const found = [item({ hash: 'deep-2', url: 'https://news.example/caught-up' })];
    const parserService = makeParserService({ items: found, strategy: 'sitemap' });
    const sourcesService = makeSourcesService();

    const result = await fetchParserWithDeepScan({ source, logger: new Logger('test'), parserService, sourcesService, budget });

    expect(parserService.deepCollect).toHaveBeenCalledTimes(1);
    expect(parserService.getDefaultMaxPages).toHaveBeenCalled();
    expect(result.items).toEqual(found);
  });

  it('passes the budget (deadline/maxArticles/crawlDelayMs) straight through to deepCollect', async () => {
    const source = makeSource({ lastSuccessAt: null, lastDeepScanAt: null });
    const parserService = makeParserService();
    const sourcesService = makeSourcesService();
    const tightBudget = { deadline: Date.now() + 5000, maxArticles: 3, crawlDelayMs: 100 };

    await fetchParserWithDeepScan({ source, logger: new Logger('test'), parserService, sourcesService, budget: tightBudget });

    expect(parserService.deepCollect).toHaveBeenCalledWith(
      source.url,
      expect.any(Date),
      expect.objectContaining(tightBudget),
    );
  });

  it('isolates a failing deep pass: returns empty items with strategy "error", does not mark the scan done, and does not throw', async () => {
    const source = makeSource({ lastSuccessAt: null, lastDeepScanAt: null });
    const parserService = makeParserService(
      undefined,
      jest.fn(async () => {
        throw new Error('sitemap host unreachable');
      }),
    );
    const sourcesService = makeSourcesService();

    const result = await fetchParserWithDeepScan({ source, logger: new Logger('test'), parserService, sourcesService, budget });

    expect(result).toEqual({ items: [], strategy: 'error' });
    expect(sourcesService.markDeepScanDone).not.toHaveBeenCalled();
  });

  it('marks the deep scan done even on a legitimate zero-result pass (strategy "none"), so it stays throttled correctly rather than retrying every /search', async () => {
    const source = makeSource({ lastSuccessAt: null, lastDeepScanAt: null });
    const parserService = makeParserService({ items: [], strategy: 'none' });
    const sourcesService = makeSourcesService();

    const result = await fetchParserWithDeepScan({ source, logger: new Logger('test'), parserService, sourcesService, budget });

    expect(result).toEqual({ items: [], strategy: 'none' });
    expect(sourcesService.markDeepScanDone).toHaveBeenCalledWith('src-1');
  });
});

describe('describeParserDeepScanNote', () => {
  it('describes every strategy with a non-empty, admin-facing note', () => {
    expect(describeParserDeepScanNote('sitemap', 12)).toContain('sitemap');
    expect(describeParserDeepScanNote('html-pagination', 3)).toContain('HTML-пагинация');
    expect(describeParserDeepScanNote('none', 0)).toContain('недоступен');
    expect(describeParserDeepScanNote('skipped', 0)).toContain('отложен');
    expect(describeParserDeepScanNote('error', 0)).toContain('ошибкой');
  });
});
