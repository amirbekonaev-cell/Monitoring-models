import { OnDemandSearchService } from './on-demand-search.service';
import { SourcesService } from '../sources/sources.service';
import { MentionsService } from '../mentions/mentions.service';
import { KeywordsService, ActiveKeywordSet } from '../keywords/keywords.service';
import { RssService } from '../collectors/rss/rss.service';
import { ParserService } from '../collectors/parser/parser.service';
import { NewsApiService } from '../collectors/search-api/newsapi.service';
import { TelegramService } from '../collectors/telegram/telegram.service';
import { VkService } from '../collectors/social/vk.service';
import { OpenAiWebSearchService } from '../collectors/social-search/openai-web-search.service';
import { Source, SourceKind, SourceStatus } from '../sources/source.entity';
import { CollectedItem } from '../common/collector-run.util';

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

function makeSource(overrides: Partial<Source> = {}): Source {
  return {
    id: 'src-1',
    url: 'https://example.com/rss',
    name: null,
    type: SourceKind.RSS,
    status: SourceStatus.ACTIVE,
    lastSuccessAt: new Date(),
    lastError: null,
    createdBy: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

/** Sources by kind; every kind not listed returns []. */
function makeSourcesService(byKind: Partial<Record<SourceKind, Source[]>>): SourcesService {
  return {
    findActiveByType: jest.fn(async (kind: SourceKind) => byKind[kind] ?? []),
  } as unknown as SourcesService;
}

function makePassthroughKeywordsService(): KeywordsService {
  const set = { match: jest.fn(async () => ({ matched: true, matchedKeywords: [] })) };
  return {
    findAll: jest.fn(async () => []),
    loadActiveKeywordSet: jest.fn(async () => set as unknown as ActiveKeywordSet),
  } as unknown as KeywordsService;
}

function item(overrides: Partial<CollectedItem> = {}): CollectedItem {
  return { title: 't', text: 'x', url: 'https://example.com/a', publishedAt: null, hash: 'h', ...overrides };
}

function makeCollectorStubs(overrides: {
  rss?: CollectedItem[];
  parser?: CollectedItem[];
  telegram?: CollectedItem[];
  newsApi?: CollectedItem[];
  vk?: CollectedItem[];
  webSearch?: CollectedItem[];
}) {
  return {
    rssService: { fetchFeed: jest.fn(async () => overrides.rss ?? []) } as unknown as RssService,
    parserService: { fetchPage: jest.fn(async () => overrides.parser ?? []) } as unknown as ParserService,
    telegramService: { fetchChannel: jest.fn(async () => overrides.telegram ?? []) } as unknown as TelegramService,
    newsApiService: { search: jest.fn(async () => overrides.newsApi ?? []) } as unknown as NewsApiService,
    vkService: { search: jest.fn(async () => overrides.vk ?? []) } as unknown as VkService,
    openAiWebSearchService: {
      search: jest.fn(async () => overrides.webSearch ?? []),
    } as unknown as OpenAiWebSearchService,
  };
}

function makeService(
  sourcesService: SourcesService,
  mentionsService: MentionsService,
  stubs: ReturnType<typeof makeCollectorStubs>,
  keywordsService: KeywordsService = makePassthroughKeywordsService(),
): OnDemandSearchService {
  return new OnDemandSearchService(
    sourcesService,
    mentionsService,
    keywordsService,
    stubs.rssService,
    stubs.parserService,
    stubs.newsApiService,
    stubs.telegramService,
    stubs.vkService,
    stubs.openAiWebSearchService,
  );
}

describe('OnDemandSearchService (/search command)', () => {
  it('applies the period cutoff best-effort: drops an item older than the window, keeps a recent one', async () => {
    const source = makeSource({ id: 'rss-1', type: SourceKind.RSS });
    const sourcesService = makeSourcesService({ [SourceKind.RSS]: [source] });
    const mentionsService = { createIfNew: jest.fn(async () => 'inserted') } as unknown as MentionsService;
    const stubs = makeCollectorStubs({
      rss: [
        item({ hash: 'old', publishedAt: daysAgo(30), url: 'https://example.com/old' }),
        item({ hash: 'recent', publishedAt: daysAgo(2), url: 'https://example.com/recent' }),
      ],
    });

    const summary = await makeService(sourcesService, mentionsService, stubs).runSearch(7);

    expect(summary.totalMatched).toBe(1);
    expect(summary.items[0].url).toBe('https://example.com/recent');
    expect(mentionsService.createIfNew).toHaveBeenCalledTimes(1);
  });

  it('keeps items with no publishedAt regardless of period (web search never returns a date)', async () => {
    const source = makeSource({ id: 'ws-1', type: SourceKind.SOCIAL_SEARCH_API, url: 'openai-search://web' });
    const sourcesService = makeSourcesService({ [SourceKind.SOCIAL_SEARCH_API]: [source] });
    const mentionsService = { createIfNew: jest.fn(async () => 'inserted') } as unknown as MentionsService;
    const stubs = makeCollectorStubs({
      webSearch: [item({ hash: 'w1', publishedAt: null, url: 'https://kz-forum.example/1', sourceLabel: 'kz-forum.example' })],
    });

    const summary = await makeService(sourcesService, mentionsService, stubs).runSearch(1);

    expect(summary.totalMatched).toBe(1);
    expect(summary.items[0].sourceLabel).toBe('kz-forum.example');
  });

  it('counts exactly one OpenAI web search call per /search run regardless of period length', async () => {
    const source = makeSource({ id: 'ws-1', type: SourceKind.SOCIAL_SEARCH_API, url: 'openai-search://web' });
    const sourcesService = makeSourcesService({ [SourceKind.SOCIAL_SEARCH_API]: [source] });
    const mentionsService = { createIfNew: jest.fn(async () => 'inserted') } as unknown as MentionsService;
    const stubs = makeCollectorStubs({ webSearch: [] });

    const summaryShort = await makeService(sourcesService, mentionsService, stubs).runSearch(1);
    const summaryLong = await makeService(sourcesService, mentionsService, stubs).runSearch(365);

    expect(summaryShort.openAiWebSearchCalls).toBe(1);
    expect(summaryLong.openAiWebSearchCalls).toBe(1);
  });

  it('marks items as "known" vs "new" based on MentionsService.createIfNew, without dropping already-known items from the summary', async () => {
    const source = makeSource({ id: 'rss-1', type: SourceKind.RSS });
    const sourcesService = makeSourcesService({ [SourceKind.RSS]: [source] });
    const mentionsService = {
      createIfNew: jest
        .fn()
        .mockResolvedValueOnce('inserted')
        .mockResolvedValueOnce('duplicate'),
    } as unknown as MentionsService;
    const stubs = makeCollectorStubs({
      rss: [
        item({ hash: 'a', url: 'https://example.com/a' }),
        item({ hash: 'b', url: 'https://example.com/b' }),
      ],
    });

    const summary = await makeService(sourcesService, mentionsService, stubs).runSearch(30);

    expect(summary.totalMatched).toBe(2);
    expect(summary.newCount).toBe(1);
    expect(summary.knownCount).toBe(1);
    expect(summary.items.map((i) => i.status)).toEqual(['new', 'known']);
  });

  it('isolates a failing source: keeps results from the other sources/channels and reports the failure', async () => {
    const rssOk = makeSource({ id: 'rss-ok', type: SourceKind.RSS, url: 'https://ok.example/rss' });
    const rssBroken = makeSource({ id: 'rss-broken', type: SourceKind.RSS, url: 'https://broken.example/rss' });
    const sourcesService = makeSourcesService({ [SourceKind.RSS]: [rssOk, rssBroken] });
    const mentionsService = { createIfNew: jest.fn(async () => 'inserted') } as unknown as MentionsService;
    const stubs = makeCollectorStubs({});
    (stubs.rssService.fetchFeed as jest.Mock).mockImplementation(async (url: string) => {
      if (url === 'https://broken.example/rss') {
        throw new Error('network timeout');
      }
      return [item({ hash: 'ok-item', url: 'https://ok.example/a' })];
    });

    const summary = await makeService(sourcesService, mentionsService, stubs).runSearch(7);

    expect(summary.totalMatched).toBe(1);
    expect(summary.sourcesFailed).toHaveLength(1);
    expect(summary.sourcesFailed[0].error).toBe('network timeout');
  });

  it('passes skipDedup: true only for the OpenAI web search channel, never for RSS', async () => {
    const rssSource = makeSource({ id: 'rss-1', type: SourceKind.RSS });
    const wsSource = makeSource({ id: 'ws-1', type: SourceKind.SOCIAL_SEARCH_API, url: 'openai-search://web' });
    const sourcesService = makeSourcesService({
      [SourceKind.RSS]: [rssSource],
      [SourceKind.SOCIAL_SEARCH_API]: [wsSource],
    });
    const mentionsService = { createIfNew: jest.fn(async () => 'inserted') } as unknown as MentionsService;
    const stubs = makeCollectorStubs({
      rss: [item({ hash: 'rss-item' })],
      webSearch: [item({ hash: 'ws-item', sourceLabel: 'forum.example' })],
    });

    await makeService(sourcesService, mentionsService, stubs).runSearch(7);

    const calls = (mentionsService.createIfNew as jest.Mock).mock.calls.map((c) => c[0]);
    const rssCall = calls.find((c) => c.hash === 'rss-item');
    const wsCall = calls.find((c) => c.hash === 'ws-item');
    expect(rssCall.skipDedup).toBeUndefined();
    expect(wsCall.skipDedup).toBe(true);
  });

  it('filters out items that do not match any active required/exact_phrase keyword', async () => {
    const source = makeSource({ id: 'rss-1', type: SourceKind.RSS });
    const sourcesService = makeSourcesService({ [SourceKind.RSS]: [source] });
    const mentionsService = { createIfNew: jest.fn(async () => 'inserted') } as unknown as MentionsService;
    const stubs = makeCollectorStubs({ rss: [item({ hash: 'unrelated' })] });
    const set = { match: jest.fn(async () => ({ matched: false, matchedKeywords: [] })) };
    const keywordsService = {
      findAll: jest.fn(async () => []),
      loadActiveKeywordSet: jest.fn(async () => set as unknown as ActiveKeywordSet),
    } as unknown as KeywordsService;

    const summary = await makeService(sourcesService, mentionsService, stubs, keywordsService).runSearch(7);

    expect(summary.totalMatched).toBe(0);
    expect(mentionsService.createIfNew).not.toHaveBeenCalled();
  });
});