import { RssService } from './rss.service';

const parseURLMock = jest.fn();

jest.mock('rss-parser', () => {
  return jest.fn().mockImplementation(() => ({
    parseURL: parseURLMock,
  }));
});

describe('RssService', () => {
  beforeEach(() => {
    parseURLMock.mockReset();
  });

  it('maps valid feed items and skips entries without a title or link', async () => {
    parseURLMock.mockResolvedValue({
      items: [
        { title: 'Valid item', link: 'https://example.com/1', contentSnippet: 'snippet', isoDate: '2026-08-17T09:00:00Z' },
        { title: '', link: 'https://example.com/2', contentSnippet: 'no title' },
        { title: 'No link', link: '', contentSnippet: 'missing link' },
      ],
    });

    const service = new RssService();
    const items = await service.fetchFeed('https://example.com/rss');

    expect(items).toHaveLength(1);
    expect(items[0].title).toBe('Valid item');
    expect(items[0].url).toBe('https://example.com/1');
    expect(items[0].hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('returns an empty array for a feed with no items (empty-result scenario)', async () => {
    parseURLMock.mockResolvedValue({ items: [] });

    const service = new RssService();
    const items = await service.fetchFeed('https://example.com/empty-rss');

    expect(items).toEqual([]);
  });

  it('propagates the error for an unreachable source so the caller can record it', async () => {
    parseURLMock.mockRejectedValue(new Error('getaddrinfo ENOTFOUND'));

    const service = new RssService();
    await expect(service.fetchFeed('https://unreachable.example/rss')).rejects.toThrow('ENOTFOUND');
  });
});
