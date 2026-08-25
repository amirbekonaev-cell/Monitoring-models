import { DataSource, Repository } from 'typeorm';
import { MentionsService } from './mentions.service';
import { Mention, Sentiment } from './mention.entity';
import { SentimentAnalysisService } from '../sentiment/sentiment-analysis.service';

/** Flushes pending microtasks — needed because sentiment classification is deliberately
 * fire-and-forget (not awaited) inside createIfNew, so it lands a few ticks later. */
function flushPromises(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function makeInput(overrides: Partial<Parameters<MentionsService['createIfNew']>[0]> = {}) {
  return {
    title: 'Заголовок новости',
    text: 'Текст новости',
    url: 'https://example.com/a',
    publishedAt: new Date('2026-08-19T10:00:00Z'),
    sourceId: 'src-1',
    sourceType: 'news' as Mention['sourceType'],
    hash: 'hash-1',
    keywords: [],
    ...overrides,
  };
}

describe('MentionsService dedup', () => {
  it('inserts a genuinely new mention', async () => {
    const repo = {
      findOne: jest.fn(async () => null),
      createQueryBuilder: jest.fn(() => ({
        insert: () => ({
          into: () => ({
            values: () => ({
              orIgnore: () => ({
                execute: async () => ({ identifiers: [{ id: 'new-id' }] }),
              }),
            }),
          }),
        }),
      })),
      update: jest.fn(),
    } as unknown as Repository<Mention>;

    const dataSource = { query: jest.fn(async () => []) } as unknown as DataSource;
    const service = new MentionsService(repo, dataSource);

    const result = await service.createIfNew(makeInput());
    expect(result).toBe('inserted');
  });

  it('records a reprint instead of inserting a duplicate row on exact hash match', async () => {
    const existing = { id: 'existing-1', url: 'https://other.com/b', reprints: [] } as unknown as Mention;
    const repo = {
      findOne: jest.fn(async () => existing),
      update: jest.fn(async () => undefined),
    } as unknown as Repository<Mention>;

    const dataSource = { query: jest.fn(async () => []) } as unknown as DataSource;
    const service = new MentionsService(repo, dataSource);

    const result = await service.createIfNew(makeInput({ hash: 'hash-1', url: 'https://example.com/a' }));

    expect(result).toBe('duplicate');
    expect(repo.update).toHaveBeenCalledWith(
      'existing-1',
      expect.objectContaining({
        reprints: [expect.objectContaining({ url: 'https://example.com/a' })],
      }),
    );
  });

  it('records a reprint when the title is near-identical (pg_trgm similarity) even with a different hash', async () => {
    const existing = { id: 'existing-2', url: 'https://original.com/x', reprints: [] } as unknown as Mention;
    const repo = {
      findOne: jest
        .fn()
        // first call: hash lookup -> nothing
        .mockResolvedValueOnce(null)
        // second call: fetch the similar mention by id
        .mockResolvedValueOnce(existing),
      update: jest.fn(async () => undefined),
    } as unknown as Repository<Mention>;

    const dataSource = {
      query: jest.fn(async () => [{ id: 'existing-2', sim: 0.9 }]),
    } as unknown as DataSource;
    const service = new MentionsService(repo, dataSource);

    const result = await service.createIfNew(makeInput({ hash: 'different-hash', url: 'https://reprint.com/y' }));

    expect(result).toBe('reprint');
    expect(repo.update).toHaveBeenCalledWith(
      'existing-2',
      expect.objectContaining({ reprints: [expect.objectContaining({ url: 'https://reprint.com/y' })] }),
    );
  });

  it('does not merge template-titled articles with different body text (e.g. daily weather columns)', async () => {
    // similarity() is a real Postgres function, so in this unit test we simulate what its
    // query would return: high title similarity ("...18 августа" vs "...19 августа"), low
    // text similarity (different day's actual content) -> the AND in the SQL WHERE clause
    // means the query itself returns no rows.
    const repo = {
      findOne: jest.fn(async () => null),
      createQueryBuilder: jest.fn(() => ({
        insert: () => ({
          into: () => ({
            values: () => ({
              orIgnore: () => ({ execute: async () => ({ identifiers: [{ id: 'new-id' }] }) }),
            }),
          }),
        }),
      })),
      update: jest.fn(),
    } as unknown as Repository<Mention>;

    const dataSource = { query: jest.fn(async () => []) } as unknown as DataSource;
    const service = new MentionsService(repo, dataSource);

    const result = await service.createIfNew(
      makeInput({
        title: 'Какая погода будет в Казахстане 19 августа',
        text: 'Завтра ожидается облачно, местами дожди, температура +22..+27',
        hash: 'weather-19-aug',
        url: 'https://ru.sputnik.kz/weather-19-avgusta',
      }),
    );

    expect(result).toBe('inserted');
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('does not add a duplicate reprint entry for the same URL twice', async () => {
    const existing = {
      id: 'existing-1',
      url: 'https://other.com/b',
      reprints: [{ url: 'https://example.com/a', sourceId: 'src-1', foundAt: '2026-08-19T00:00:00Z' }],
    } as unknown as Mention;
    const repo = {
      findOne: jest.fn(async () => existing),
      update: jest.fn(async () => undefined),
    } as unknown as Repository<Mention>;

    const dataSource = { query: jest.fn(async () => []) } as unknown as DataSource;
    const service = new MentionsService(repo, dataSource);

    await service.createIfNew(makeInput({ hash: 'hash-1', url: 'https://example.com/a' }));

    expect(repo.update).not.toHaveBeenCalled();
  });

  it('marks a genuinely new, non-backfill mention as not-yet-notified', async () => {
    let insertedValues: Record<string, unknown> | undefined;
    const repo = {
      findOne: jest.fn(async () => null),
      createQueryBuilder: jest.fn(() => ({
        insert: () => ({
          into: () => ({
            values: (v: Record<string, unknown>) => {
              insertedValues = v;
              return { orIgnore: () => ({ execute: async () => ({ identifiers: [{ id: 'new-id' }] }) }) };
            },
          }),
        }),
      })),
      update: jest.fn(),
    } as unknown as Repository<Mention>;

    const dataSource = { query: jest.fn(async () => []) } as unknown as DataSource;
    const service = new MentionsService(repo, dataSource);

    const result = await service.createIfNew(makeInput({ isBackfill: false }));

    expect(result).toBe('inserted');
    expect(insertedValues).toEqual(expect.objectContaining({ isBackfill: false, notificationSent: false }));
  });

  it('marks a backfill mention as already-notified', async () => {
    let insertedValues: Record<string, unknown> | undefined;
    const repo = {
      findOne: jest.fn(async () => null),
      createQueryBuilder: jest.fn(() => ({
        insert: () => ({
          into: () => ({
            values: (v: Record<string, unknown>) => {
              insertedValues = v;
              return { orIgnore: () => ({ execute: async () => ({ identifiers: [{ id: 'new-id' }] }) }) };
            },
          }),
        }),
      })),
      update: jest.fn(),
    } as unknown as Repository<Mention>;

    const dataSource = { query: jest.fn(async () => []) } as unknown as DataSource;
    const service = new MentionsService(repo, dataSource);

    const result = await service.createIfNew(makeInput({ isBackfill: true }));

    expect(result).toBe('inserted');
    expect(insertedValues).toEqual(expect.objectContaining({ isBackfill: true, notificationSent: true }));
  });

  it('classifies sentiment for every genuinely new mention in the background (not queued, not awaited by the insert)', async () => {
    const inserted = { id: 'new-id', title: 'Заголовок новости', text: 'Текст новости', url: 'https://example.com/a' } as Mention;
    const repo = {
      findOne: jest
        .fn()
        // dedup hash lookup during createIfNew -> nothing
        .mockResolvedValueOnce(null)
        // findById() from inside the background classify call
        .mockResolvedValueOnce(inserted),
      createQueryBuilder: jest.fn(() => ({
        insert: () => ({
          into: () => ({
            values: () => ({ orIgnore: () => ({ execute: async () => ({ identifiers: [{ id: 'new-id' }] }) }) }),
          }),
        }),
        update: () => ({ set: () => ({ where: () => ({ execute: jest.fn(async () => ({ affected: 1 })) }) }) }),
      })),
      update: jest.fn(),
    } as unknown as Repository<Mention>;

    const dataSource = { query: jest.fn(async () => []) } as unknown as DataSource;
    const sentimentAnalysisService = {
      classify: jest.fn(async () => ({ sentiment: Sentiment.POSITIVE, reason: 'r', summary: 's' })),
    } as unknown as SentimentAnalysisService;
    const service = new MentionsService(repo, dataSource, sentimentAnalysisService);

    const result = await service.createIfNew(makeInput({ isBackfill: true }));
    expect(result).toBe('inserted');

    await flushPromises();

    expect(sentimentAnalysisService.classify).toHaveBeenCalledWith(inserted.title, inserted.text, inserted.url);
  });

  it('does not let a sentiment classification failure propagate out of, or block, the insert', async () => {
    const inserted = { id: 'new-id', title: 't', text: 'x', url: 'https://example.com/a' } as Mention;
    const repo = {
      findOne: jest.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(inserted),
      createQueryBuilder: jest.fn(() => ({
        insert: () => ({
          into: () => ({
            values: () => ({ orIgnore: () => ({ execute: async () => ({ identifiers: [{ id: 'new-id' }] }) }) }),
          }),
        }),
      })),
      update: jest.fn(),
    } as unknown as Repository<Mention>;

    const dataSource = { query: jest.fn(async () => []) } as unknown as DataSource;
    const sentimentAnalysisService = {
      classify: jest.fn(async () => {
        throw new Error('OpenAI unavailable');
      }),
    } as unknown as SentimentAnalysisService;
    const service = new MentionsService(repo, dataSource, sentimentAnalysisService);

    await expect(service.createIfNew(makeInput())).resolves.toBe('inserted');
    await flushPromises();
  });

  it('skipDedup: inserts even when an identical hash already exists, without checking for one', async () => {
    const repo = {
      findOne: jest.fn(async () => {
        throw new Error('should not be called when skipDedup is set');
      }),
      createQueryBuilder: jest.fn(() => ({
        insert: () => ({
          into: () => ({
            values: () => ({
              orIgnore: () => ({ execute: async () => ({ identifiers: [{ id: 'new-id' }] }) }),
            }),
          }),
        }),
      })),
      update: jest.fn(),
    } as unknown as Repository<Mention>;

    const dataSource = {
      query: jest.fn(async () => {
        throw new Error('similarity check should not run when skipDedup is set');
      }),
    } as unknown as DataSource;
    const service = new MentionsService(repo, dataSource);

    const result = await service.createIfNew(makeInput({ hash: 'same-hash-every-time', skipDedup: true }));

    expect(result).toBe('inserted');
    expect(repo.findOne).not.toHaveBeenCalled();
  });

  it('skipDedup: gives each insert a unique 64-char hash so identical findings never collide with the varchar(64) unique hash column', async () => {
    const insertedHashes: string[] = [];
    const repo = {
      findOne: jest.fn(),
      createQueryBuilder: jest.fn(() => ({
        insert: () => ({
          into: () => ({
            values: (v: Record<string, unknown>) => {
              insertedHashes.push(v.hash as string);
              return { orIgnore: () => ({ execute: async () => ({ identifiers: [{ id: 'new-id' }] }) }) };
            },
          }),
        }),
      })),
      update: jest.fn(),
    } as unknown as Repository<Mention>;

    const dataSource = { query: jest.fn() } as unknown as DataSource;
    const service = new MentionsService(repo, dataSource);

    await service.createIfNew(makeInput({ hash: 'content-hash', skipDedup: true }));
    await service.createIfNew(makeInput({ hash: 'content-hash', skipDedup: true }));

    expect(insertedHashes).toHaveLength(2);
    expect(insertedHashes[0]).not.toBe(insertedHashes[1]);
    // Must fit the DB column (varchar(64)) — a naive `${hash}:${uuid()}` concatenation would
    // overflow it; this is exactly the bug that broke every K-6 insert in production.
    expect(insertedHashes[0]).toHaveLength(64);
    expect(insertedHashes[1]).toHaveLength(64);
  });

  it('does not skip dedup by default (skipDedup omitted keeps normal hash-duplicate behaviour)', async () => {
    const existing = { id: 'existing-1', url: 'https://other.com/b', reprints: [] } as unknown as Mention;
    const repo = {
      findOne: jest.fn(async () => existing),
      update: jest.fn(async () => undefined),
    } as unknown as Repository<Mention>;
    const dataSource = { query: jest.fn(async () => []) } as unknown as DataSource;
    const service = new MentionsService(repo, dataSource);

    const result = await service.createIfNew(makeInput({ hash: 'hash-1' }));

    expect(result).toBe('duplicate');
  });

  it('claimForNotification flips notification_sent false->true exactly once (no double send)', async () => {
    const executeMock = jest
      .fn()
      .mockResolvedValueOnce({ affected: 1 })
      .mockResolvedValueOnce({ affected: 0 });
    const repo = {
      createQueryBuilder: jest.fn(() => ({
        update: () => ({
          set: () => ({
            where: () => ({ execute: executeMock }),
          }),
        }),
      })),
    } as unknown as Repository<Mention>;
    const dataSource = {} as unknown as DataSource;
    const service = new MentionsService(repo, dataSource);

    const firstClaim = await service.claimForNotification('m-1');
    const secondClaim = await service.claimForNotification('m-1');

    expect(firstClaim).toBe(true);
    expect(secondClaim).toBe(false);
  });

  it('markNotificationFailed resets the flag so a retry can claim again', async () => {
    const repo = { update: jest.fn(async () => undefined) } as unknown as Repository<Mention>;
    const dataSource = {} as unknown as DataSource;
    const service = new MentionsService(repo, dataSource);

    await service.markNotificationFailed('m-1');

    expect(repo.update).toHaveBeenCalledWith('m-1', { notificationSent: false });
  });

  it('updateSentiment writes the machine classification and keeps sentimentManual false', async () => {
    const setMock = jest.fn(() => ({ where: whereMock }));
    const whereMock = jest.fn(() => ({ execute: jest.fn(async () => ({ affected: 1 })) }));
    const repo = {
      createQueryBuilder: jest.fn(() => ({ update: () => ({ set: setMock }) })),
    } as unknown as Repository<Mention>;
    const dataSource = {} as unknown as DataSource;
    const service = new MentionsService(repo, dataSource);

    await service.updateSentiment('m-1', Sentiment.POSITIVE);

    expect(setMock).toHaveBeenCalledWith({ sentiment: Sentiment.POSITIVE, sentimentManual: false });
    expect(whereMock).toHaveBeenCalledWith('id = :id AND sentiment_manual = false', { id: 'm-1' });
  });

  it('updateSentiment also writes the LLM-generated summary when provided', async () => {
    const setMock = jest.fn(() => ({ where: () => ({ execute: jest.fn(async () => ({ affected: 1 })) }) }));
    const repo = {
      createQueryBuilder: jest.fn(() => ({ update: () => ({ set: setMock }) })),
    } as unknown as Repository<Mention>;
    const dataSource = {} as unknown as DataSource;
    const service = new MentionsService(repo, dataSource);

    await service.updateSentiment('m-1', Sentiment.POSITIVE, 'Краткий пересказ статьи.');

    expect(setMock).toHaveBeenCalledWith({
      sentiment: Sentiment.POSITIVE,
      sentimentManual: false,
      summary: 'Краткий пересказ статьи.',
    });
  });

  it('updateSentiment is a no-op (via the sentiment_manual = false guard) when the mention was already edited manually', async () => {
    const executeMock = jest.fn(async () => ({ affected: 0 }));
    const repo = {
      createQueryBuilder: jest.fn(() => ({
        update: () => ({ set: () => ({ where: () => ({ execute: executeMock }) }) }),
      })),
    } as unknown as Repository<Mention>;
    const dataSource = {} as unknown as DataSource;
    const service = new MentionsService(repo, dataSource);

    await expect(service.updateSentiment('m-1', Sentiment.NEGATIVE)).resolves.toBeUndefined();
    expect(executeMock).toHaveBeenCalled();
  });

  it('updateSentimentManually sets sentimentManual = true and returns the updated mention', async () => {
    const updated = { id: 'm-1', sentiment: Sentiment.NEGATIVE, sentimentManual: true } as Mention;
    const setMock = jest.fn(() => ({ where: whereMock }));
    const whereMock = jest.fn(() => ({ execute: jest.fn(async () => ({ affected: 1 })) }));
    const repo = {
      createQueryBuilder: jest.fn(() => ({ update: () => ({ set: setMock }) })),
      findOne: jest.fn(async () => updated),
    } as unknown as Repository<Mention>;
    const dataSource = {} as unknown as DataSource;
    const service = new MentionsService(repo, dataSource);

    const result = await service.updateSentimentManually('m-1', Sentiment.NEGATIVE);

    expect(setMock).toHaveBeenCalledWith({ sentiment: Sentiment.NEGATIVE, sentimentManual: true });
    expect(result).toEqual(updated);
  });

  it('updateSentimentManually returns null when the mention does not exist', async () => {
    const repo = {
      createQueryBuilder: jest.fn(() => ({
        update: () => ({ set: () => ({ where: () => ({ execute: jest.fn(async () => ({ affected: 0 })) }) }) }),
      })),
      findOne: jest.fn(),
    } as unknown as Repository<Mention>;
    const dataSource = {} as unknown as DataSource;
    const service = new MentionsService(repo, dataSource);

    const result = await service.updateSentimentManually('missing', Sentiment.NEGATIVE);

    expect(result).toBeNull();
    expect(repo.findOne).not.toHaveBeenCalled();
  });
});