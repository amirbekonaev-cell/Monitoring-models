import { SourceDetectService } from './source-detect.service';
import { RssService } from '../../collectors/rss/rss.service';
import { ParserService } from '../../collectors/parser/parser.service';
import { SourceKind } from '../source.entity';

describe('SourceDetectService', () => {
  it('detects a Telegram channel link without touching RSS/parser checks', async () => {
    const rssService = { fetchFeed: jest.fn() } as unknown as RssService;
    const parserService = { discoverRssFeed: jest.fn() } as unknown as ParserService;
    const service = new SourceDetectService(rssService, parserService);

    const result = await service.detect('https://t.me/some_channel');

    expect(result).toEqual({ type: SourceKind.TELEGRAM, resolvedUrl: 'https://t.me/some_channel' });
    expect(rssService.fetchFeed).not.toHaveBeenCalled();
  });

  it('detects a direct RSS feed URL', async () => {
    const rssService = {
      fetchFeed: jest.fn(async () => [{ title: 'x', text: '', url: 'https://a', publishedAt: null, hash: 'h' }]),
    } as unknown as RssService;
    const parserService = { discoverRssFeed: jest.fn() } as unknown as ParserService;
    const service = new SourceDetectService(rssService, parserService);

    const result = await service.detect('https://example.com/feed.xml');

    expect(result.type).toBe(SourceKind.RSS);
    expect(parserService.discoverRssFeed).not.toHaveBeenCalled();
  });

  it('detects RSS discoverable via a linked <link rel="alternate"> feed', async () => {
    const rssService = {
      fetchFeed: jest.fn(async (url: string) => {
        if (url === 'https://example.com/discovered.xml') {
          return [{ title: 'x', text: '', url: 'https://a', publishedAt: null, hash: 'h' }];
        }
        throw new Error('not a feed');
      }),
    } as unknown as RssService;
    const parserService = {
      discoverRssFeed: jest.fn(async () => 'https://example.com/discovered.xml'),
    } as unknown as ParserService;
    const service = new SourceDetectService(rssService, parserService);

    const result = await service.detect('https://example.com/news');

    expect(result).toEqual({ type: SourceKind.RSS, resolvedUrl: 'https://example.com/discovered.xml' });
  });

  it('falls back to the universal parser (К-5) when no RSS is found and it is not Telegram', async () => {
    const rssService = {
      fetchFeed: jest.fn(async () => {
        throw new Error('not a feed');
      }),
    } as unknown as RssService;
    const parserService = { discoverRssFeed: jest.fn(async () => null) } as unknown as ParserService;
    const service = new SourceDetectService(rssService, parserService);

    const result = await service.detect('example.com/some-article');

    expect(result).toEqual({ type: SourceKind.PARSER, resolvedUrl: 'https://example.com/some-article' });
  });
});
