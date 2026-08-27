import { BadRequestException } from '@nestjs/common';
import { SourceOnboardingService } from './source-onboarding.service';
import { SourceDetectService } from './source-detect.service';
import { SourcesService } from '../sources.service';
import { MentionsService } from '../../mentions/mentions.service';
import { KeywordsService, ActiveKeywordSet } from '../../keywords/keywords.service';
import { SettingsService } from '../../settings/settings.service';
import { RssService } from '../../collectors/rss/rss.service';
import { TelegramService } from '../../collectors/telegram/telegram.service';
import { ParserService } from '../../collectors/parser/parser.service';
import { DomainExclusionService } from '../../common/domain-exclusion.service';
import { SourceKind, SourceStatus } from '../source.entity';

function makePassthroughDomainExclusionService(): DomainExclusionService {
  return { isUrlExcluded: jest.fn(() => false) } as unknown as DomainExclusionService;
}

function makeKeywordsService(): KeywordsService {
  const passThroughSet = { match: jest.fn(async () => ({ matched: true, matchedKeywords: [] })) };
  return {
    loadActiveKeywordSet: jest.fn(async () => passThroughSet as unknown as ActiveKeywordSet),
  } as unknown as KeywordsService;
}

function makeSettingsService(enabled = true): SettingsService {
  return { isCollectionEnabled: jest.fn(async () => enabled) } as unknown as SettingsService;
}

describe('SourceOnboardingService', () => {
  it('rejects a URL that is already registered', async () => {
    const detectService = {
      detect: jest.fn(async () => ({ type: SourceKind.RSS, resolvedUrl: 'https://existing.example/rss' })),
    } as unknown as SourceDetectService;
    const sourcesService = {
      findByUrl: jest.fn(async () => ({ id: 'existing' })),
    } as unknown as SourcesService;

    const service = new SourceOnboardingService(
      detectService,
      sourcesService,
      {} as MentionsService,
      makeKeywordsService(),
      makeSettingsService(),
      {} as RssService,
      {} as TelegramService,
      {} as ParserService,
      makePassthroughDomainExclusionService(),
    );

    await expect(service.addByLink('https://existing.example', null, 'admin')).rejects.toThrow(BadRequestException);
  });

  it('creates the source and runs one immediate test collection, reporting how many items it found', async () => {
    const createdSource = {
      id: 'src-1',
      url: 'https://news.example/rss',
      name: null,
      type: SourceKind.RSS,
      status: SourceStatus.ACTIVE,
      lastSuccessAt: null,
      lastDeepScanAt: null,
      lastError: null,
      createdBy: 'import-script',
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const detectService = {
      detect: jest.fn(async () => ({ type: SourceKind.RSS, resolvedUrl: createdSource.url })),
    } as unknown as SourceDetectService;
    const sourcesService = {
      findByUrl: jest.fn(async () => null),
      create: jest.fn(async () => createdSource),
      findById: jest.fn(async () => ({ ...createdSource, lastSuccessAt: new Date(), lastError: null })),
      markSuccess: jest.fn(async () => undefined),
      markError: jest.fn(async () => undefined),
      markDeepScanDone: jest.fn(async () => undefined),
    } as unknown as SourcesService;
    const mentionsService = {
      createIfNew: jest.fn(async () => 'inserted'),
    } as unknown as MentionsService;
    const rssService = {
      fetchFeed: jest.fn(async () => [
        { title: 'A', text: 'text', url: 'https://news.example/a', publishedAt: null, hash: 'h1' },
      ]),
    } as unknown as RssService;
    // A brand-new source's first cycle also triggers the one-time sitemap/HTML-pagination
    // backfill deep pass (see rss-deep-scan.util.ts) — stub it to a no-op so this test stays
    // focused on the plain RSS path; deep-scan behavior itself is covered in
    // rss-deep-scan.util.spec.ts.
    const parserService = {
      deepCollect: jest.fn(async () => ({ items: [], strategy: 'none' })),
      getBackfillMaxPages: jest.fn(() => 25),
      getDefaultMaxPages: jest.fn(() => 5),
    } as unknown as ParserService;

    const service = new SourceOnboardingService(
      detectService,
      sourcesService,
      mentionsService,
      makeKeywordsService(),
      makeSettingsService(),
      rssService,
      {} as TelegramService,
      parserService,
      makePassthroughDomainExclusionService(),
    );

    const result = await service.addByLink('news.example/rss', null, 'import-script');

    expect(result.ok).toBe(true);
    expect(result.itemsFound).toBe(1);
    expect(result.itemsNew).toBe(1);
    expect(sourcesService.create).toHaveBeenCalledWith(
      expect.objectContaining({ createdBy: 'import-script', type: SourceKind.RSS }),
    );
  });

  it('reports a clear reason (not a stack trace) when the test collection fails', async () => {
    // RSS, not PARSER: RSS's fast feed fetch is a real primary path whose failure is a genuine
    // source error (see rss-deep-scan.util.ts — only the *deep pass* on top of it is isolated).
    // PARSER's own error handling (deepCollect failing) is intentionally different — see
    // "PARSER: a failing deep pass degrades to itemsFound: 0 instead of ok: false" below and
    // CLAUDE.md task ФТ-2 reasoning.
    const createdSource = {
      id: 'src-2',
      url: 'https://broken.example/rss',
      name: null,
      type: SourceKind.RSS,
      status: SourceStatus.ACTIVE,
      lastSuccessAt: null,
      lastDeepScanAt: null,
      lastError: null,
      createdBy: 'import-script',
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const detectService = {
      detect: jest.fn(async () => ({ type: SourceKind.RSS, resolvedUrl: createdSource.url })),
    } as unknown as SourceDetectService;
    const sourcesService = {
      findByUrl: jest.fn(async () => null),
      create: jest.fn(async () => createdSource),
      findById: jest.fn(async () => ({ ...createdSource, lastError: 'HTTP 404' })),
      markSuccess: jest.fn(async () => undefined),
      markError: jest.fn(async () => undefined),
    } as unknown as SourcesService;
    const rssService = {
      fetchFeed: jest.fn(async () => {
        throw new Error('HTTP 404');
      }),
    } as unknown as RssService;

    const service = new SourceOnboardingService(
      detectService,
      sourcesService,
      {} as MentionsService,
      makeKeywordsService(),
      makeSettingsService(),
      rssService,
      {} as TelegramService,
      {} as ParserService,
      makePassthroughDomainExclusionService(),
    );

    const result = await service.addByLink('broken.example', null, 'import-script');

    expect(result.ok).toBe(false);
    expect(result.message).toBe('HTTP 404');
  });

  it('routes a PARSER source through fetchParserWithDeepScan (not the bare fetchPage() single-article fetch) and reports which deep-scan path ran via deepScanNote', async () => {
    const createdSource = {
      id: 'src-parser-1',
      url: 'https://sknews.example/',
      name: null,
      type: SourceKind.PARSER,
      status: SourceStatus.ACTIVE,
      lastSuccessAt: null,
      lastDeepScanAt: null,
      lastError: null,
      createdBy: 'import-script',
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const detectService = {
      detect: jest.fn(async () => ({ type: SourceKind.PARSER, resolvedUrl: createdSource.url })),
    } as unknown as SourceDetectService;
    const sourcesService = {
      findByUrl: jest.fn(async () => null),
      create: jest.fn(async () => createdSource),
      findById: jest.fn(async () => ({ ...createdSource, lastSuccessAt: new Date() })),
      markSuccess: jest.fn(async () => undefined),
      markError: jest.fn(async () => undefined),
      markDeepScanDone: jest.fn(async () => undefined),
    } as unknown as SourcesService;
    const parserService = {
      fetchPage: jest.fn(async () => {
        throw new Error('fetchPage must not be called for a PARSER source any more');
      }),
      deepCollect: jest.fn(async () => ({
        items: [{ title: 'A', text: 'text', url: 'https://sknews.example/article-1', publishedAt: null, hash: 'h1' }],
        strategy: 'sitemap',
      })),
      getBackfillMaxPages: jest.fn(() => 25),
      getDefaultMaxPages: jest.fn(() => 5),
    } as unknown as ParserService;

    const service = new SourceOnboardingService(
      detectService,
      sourcesService,
      { createIfNew: jest.fn(async () => 'inserted') } as unknown as MentionsService,
      makeKeywordsService(),
      makeSettingsService(),
      {} as RssService,
      {} as TelegramService,
      parserService,
      makePassthroughDomainExclusionService(),
    );

    const result = await service.addByLink('sknews.example', null, 'import-script');

    expect(parserService.fetchPage).not.toHaveBeenCalled();
    expect(parserService.deepCollect).toHaveBeenCalledTimes(1);
    expect(sourcesService.markDeepScanDone).toHaveBeenCalledWith('src-parser-1');
    expect(result.ok).toBe(true);
    expect(result.itemsFound).toBe(1);
    expect(result.deepScanNote).toContain('sitemap');
  });

  it('PARSER: a failing deep pass degrades to itemsFound: 0 (not ok: false) — an admin still sees the source added, with the error surfaced via deepScanNote instead of lastError', async () => {
    const createdSource = {
      id: 'src-parser-2',
      url: 'https://broken-parser.example/',
      name: null,
      type: SourceKind.PARSER,
      status: SourceStatus.ACTIVE,
      lastSuccessAt: null,
      lastDeepScanAt: null,
      lastError: null,
      createdBy: 'import-script',
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const detectService = {
      detect: jest.fn(async () => ({ type: SourceKind.PARSER, resolvedUrl: createdSource.url })),
    } as unknown as SourceDetectService;
    const sourcesService = {
      findByUrl: jest.fn(async () => null),
      create: jest.fn(async () => createdSource),
      findById: jest.fn(async () => ({ ...createdSource, lastSuccessAt: new Date() })),
      markSuccess: jest.fn(async () => undefined),
      markError: jest.fn(async () => undefined),
      markDeepScanDone: jest.fn(async () => undefined),
    } as unknown as SourcesService;
    const parserService = {
      fetchPage: jest.fn(),
      deepCollect: jest.fn(async () => {
        throw new Error('DNS lookup failed');
      }),
      getBackfillMaxPages: jest.fn(() => 25),
      getDefaultMaxPages: jest.fn(() => 5),
    } as unknown as ParserService;

    const service = new SourceOnboardingService(
      detectService,
      sourcesService,
      {} as MentionsService,
      makeKeywordsService(),
      makeSettingsService(),
      {} as RssService,
      {} as TelegramService,
      parserService,
      makePassthroughDomainExclusionService(),
    );

    const result = await service.addByLink('broken-parser.example', null, 'import-script');

    expect(sourcesService.markDeepScanDone).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
    expect(result.itemsFound).toBe(0);
    expect(result.deepScanNote).toContain('ошибкой');
  });

  it('reports collection is paused (not "0 found") when adding a source while /pause is active', async () => {
    const createdSource = {
      id: 'src-3',
      url: 'https://news.example/rss',
      name: null,
      type: SourceKind.RSS,
      status: SourceStatus.ACTIVE,
      lastSuccessAt: null,
      lastDeepScanAt: null,
      lastError: null,
      createdBy: 'admin',
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const detectService = {
      detect: jest.fn(async () => ({ type: SourceKind.RSS, resolvedUrl: createdSource.url })),
    } as unknown as SourceDetectService;
    const sourcesService = {
      findByUrl: jest.fn(async () => null),
      create: jest.fn(async () => createdSource),
      findById: jest.fn(async () => createdSource),
      markSuccess: jest.fn(async () => undefined),
      markError: jest.fn(async () => undefined),
    } as unknown as SourcesService;
    const rssService = { fetchFeed: jest.fn() } as unknown as RssService;

    const service = new SourceOnboardingService(
      detectService,
      sourcesService,
      {} as MentionsService,
      makeKeywordsService(),
      makeSettingsService(false),
      rssService,
      {} as TelegramService,
      {} as ParserService,
      makePassthroughDomainExclusionService(),
    );

    const result = await service.addByLink('news.example/rss', null, 'admin');

    expect(result.ok).toBe(true);
    expect(result.message).toContain('на паузе');
    expect(rssService.fetchFeed).not.toHaveBeenCalled();
  });

  it('rejects a blacklisted domain before even trying to detect/reach it', async () => {
    const detectService = { detect: jest.fn() } as unknown as SourceDetectService;
    const sourcesService = { findByUrl: jest.fn(), create: jest.fn() } as unknown as SourcesService;
    const domainExclusionService = { isUrlExcluded: jest.fn(() => true) } as unknown as DomainExclusionService;

    const service = new SourceOnboardingService(
      detectService,
      sourcesService,
      {} as MentionsService,
      makeKeywordsService(),
      makeSettingsService(),
      {} as RssService,
      {} as TelegramService,
      {} as ParserService,
      domainExclusionService,
    );

    await expect(service.addByLink('https://goszakup.gov.kz', null, 'admin')).rejects.toThrow(BadRequestException);
    expect(detectService.detect).not.toHaveBeenCalled();
    expect(sourcesService.create).not.toHaveBeenCalled();
  });
});