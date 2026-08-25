import { RssProcessor } from './rss.processor';
import { RssService } from './rss.service';
import { SourcesService } from '../../sources/sources.service';
import { MentionsService } from '../../mentions/mentions.service';
import { KeywordsService, ActiveKeywordSet } from '../../keywords/keywords.service';
import { SourceKind, SourceStatus } from '../../sources/source.entity';
import { Job } from 'bullmq';

function makeSource(id: string, url: string) {
  return {
    id,
    url,
    name: null,
    type: SourceKind.RSS,
    status: SourceStatus.ACTIVE,
    lastSuccessAt: null,
    lastError: null,
    createdBy: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function makeKeywordsService(): KeywordsService {
  const passThroughSet = { match: jest.fn(async () => ({ matched: true, matchedKeywords: [] })) };
  return {
    loadActiveKeywordSet: jest.fn(async () => passThroughSet as unknown as ActiveKeywordSet),
  } as unknown as KeywordsService;
}

describe('RssProcessor', () => {
  it('keeps polling remaining sources when one source fails, and reports duplicates correctly', async () => {
    const sourceOk = makeSource('src-ok', 'https://ok.example/rss');
    const sourceBroken = makeSource('src-broken', 'https://broken.example/rss');

    const rssService = {
      fetchFeed: jest.fn(async (url: string) => {
        if (url === sourceBroken.url) {
          throw new Error('network timeout');
        }
        return [
          {
            title: 'A',
            text: 'text A',
            url: 'https://ok.example/a',
            publishedAt: null,
            hash: 'hash-a',
          },
          {
            title: 'B (duplicate)',
            text: 'text B',
            url: 'https://ok.example/b',
            publishedAt: null,
            hash: 'hash-b',
          },
        ];
      }),
    } as unknown as RssService;

    const sourcesService = {
      findActiveByType: jest.fn(async () => [sourceOk, sourceBroken]),
      markSuccess: jest.fn(async () => undefined),
      markError: jest.fn(async () => undefined),
    } as unknown as SourcesService;

    const mentionsService = {
      // first item is new, second is a duplicate already in DB
      createIfNew: jest.fn().mockResolvedValueOnce('inserted').mockResolvedValueOnce('duplicate'),
    } as unknown as MentionsService;

    const processor = new RssProcessor(rssService, sourcesService, mentionsService, makeKeywordsService());

    await processor.process({} as Job);

    expect(rssService.fetchFeed).toHaveBeenCalledTimes(2);
    expect(mentionsService.createIfNew).toHaveBeenCalledTimes(2);

    // the failing source must not stop processing of the working one
    expect(sourcesService.markSuccess).toHaveBeenCalledWith(sourceOk.id);
    expect(sourcesService.markError).toHaveBeenCalledWith(sourceBroken.id, 'network timeout');
  });

  it('marks a source as error and continues when the feed is unreachable, without inserting mentions for it', async () => {
    const sourceBroken = makeSource('src-broken', 'https://broken.example/rss');

    const rssService = {
      fetchFeed: jest.fn(async () => {
        throw new Error('ENOTFOUND');
      }),
    } as unknown as RssService;

    const sourcesService = {
      findActiveByType: jest.fn(async () => [sourceBroken]),
      markSuccess: jest.fn(async () => undefined),
      markError: jest.fn(async () => undefined),
    } as unknown as SourcesService;

    const mentionsService = {
      createIfNew: jest.fn(),
    } as unknown as MentionsService;

    const processor = new RssProcessor(rssService, sourcesService, mentionsService, makeKeywordsService());

    await processor.process({} as Job);

    expect(mentionsService.createIfNew).not.toHaveBeenCalled();
    expect(sourcesService.markError).toHaveBeenCalledWith(sourceBroken.id, 'ENOTFOUND');
    expect(sourcesService.markSuccess).not.toHaveBeenCalled();
  });

  it('filters out items that do not match active keywords, without failing the source', async () => {
    const source = makeSource('src-1', 'https://ok.example/rss');

    const rssService = {
      fetchFeed: jest.fn(async () => [
        { title: 'irrelevant', text: 'nothing to do with us', url: 'https://ok.example/x', publishedAt: null, hash: 'h1' },
      ]),
    } as unknown as RssService;

    const sourcesService = {
      findActiveByType: jest.fn(async () => [source]),
      markSuccess: jest.fn(async () => undefined),
      markError: jest.fn(async () => undefined),
    } as unknown as SourcesService;

    const mentionsService = { createIfNew: jest.fn() } as unknown as MentionsService;

    const rejectingSet = { match: jest.fn(async () => ({ matched: false, matchedKeywords: [] })) };
    const keywordsService = {
      loadActiveKeywordSet: jest.fn(async () => rejectingSet as unknown as ActiveKeywordSet),
    } as unknown as KeywordsService;

    const processor = new RssProcessor(rssService, sourcesService, mentionsService, keywordsService);
    await processor.process({} as Job);

    expect(mentionsService.createIfNew).not.toHaveBeenCalled();
    expect(sourcesService.markSuccess).toHaveBeenCalledWith(source.id);
  });
});
