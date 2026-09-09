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

  it('createIfNewAndClassify awaits classification (not fire-and-forget) and returns the real sentiment for a new mention', async () => {
    const inserted = { id: 'new-id', title: 'Заголовок', text: 'Текст', url: 'https://example.com/a' } as Mention;
    const classified = { ...inserted, sentiment: Sentiment.POSITIVE } as Mention;
    const repo = {
      findOne: jest
        .fn()
        // dedup hash lookup -> nothing
        .mockResolvedValueOnce(null)
        // findById() inside classifySentimentInBackground, before classify() runs
        .mockResolvedValueOnce(inserted)
        // createIfNewAndClassify's own findById() after classification completes
        .mockResolvedValueOnce(classified),
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

    const result = await service.createIfNewAndClassify(makeInput());

    // No flushPromises() needed here — unlike createIfNew's fire-and-forget, this call must have
    // already awaited classify() before resolving.
    expect(sentimentAnalysisService.classify).toHaveBeenCalledWith(inserted.title, inserted.text, inserted.url);
    expect(result).toEqual({ result: 'inserted', sentiment: Sentiment.POSITIVE });
  });

  it('createIfNewAndClassify reads back the already-stored sentiment for a known (duplicate) mention instead of reclassifying it', async () => {
    const existing = {
      id: 'existing-1',
      url: 'https://other.com/b',
      reprints: [],
      sentiment: Sentiment.NEGATIVE,
    } as unknown as Mention;
    const repo = {
      findOne: jest
        .fn()
        // hash dedup lookup -> existing mention
        .mockResolvedValueOnce(existing)
        // findById() by the existing mention's id, not by anything from `input`
        .mockResolvedValueOnce(existing),
      update: jest.fn(async () => undefined),
    } as unknown as Repository<Mention>;

    const dataSource = { query: jest.fn(async () => []) } as unknown as DataSource;
    const sentimentAnalysisService = {
      classify: jest.fn(),
    } as unknown as SentimentAnalysisService;
    const service = new MentionsService(repo, dataSource, sentimentAnalysisService);

    const result = await service.createIfNewAndClassify(makeInput({ hash: 'hash-1', url: 'https://example.com/a' }));

    expect(result).toEqual({ result: 'duplicate', sentiment: Sentiment.NEGATIVE });
    expect(sentimentAnalysisService.classify).not.toHaveBeenCalled();
  });

  it('createIfNewAndClassify falls back to Sentiment.UNDEFINED when OPENAI_API_KEY is not configured, without throwing', async () => {
    const inserted = { id: 'new-id', title: 't', text: 'x', url: 'https://example.com/a', sentiment: Sentiment.UNDEFINED } as Mention;
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
    // No SentimentAnalysisService injected at all — mirrors the OPENAI_API_KEY-not-set case.
    const service = new MentionsService(repo, dataSource);

    const result = await service.createIfNewAndClassify(makeInput());

    expect(result).toEqual({ result: 'inserted', sentiment: Sentiment.UNDEFINED });
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

/** Chainable stand-in for TypeORM's SelectQueryBuilder — every builder method returns the same
 *  object (as the real one does), so calls can be composed the way MentionsService composes
 *  them; only the terminal methods (getManyAndCount/getCount/getRawMany) are given real results. */
function makeQueryBuilderMock(overrides: Record<string, unknown> = {}) {
  const qb: Record<string, jest.Mock> = {};
  for (const method of ['select', 'addSelect', 'where', 'andWhere', 'orderBy', 'addOrderBy', 'groupBy', 'addGroupBy', 'leftJoin', 'take', 'skip', 'limit']) {
    qb[method] = jest.fn(() => qb);
  }
  qb.getManyAndCount = jest.fn(async () => [[], 0]);
  qb.getCount = jest.fn(async () => 0);
  qb.getRawMany = jest.fn(async () => []);
  Object.assign(qb, overrides);
  return qb;
}

describe('MentionsService filters & stats', () => {
  it('findRecent turns every provided filter into an andWhere clause', async () => {
    const qb = makeQueryBuilderMock({ getManyAndCount: jest.fn(async () => [[{ id: 'm-1' }], 1]) });
    const repo = { createQueryBuilder: jest.fn(() => qb) } as unknown as Repository<Mention>;
    const dataSource = {} as unknown as DataSource;
    const service = new MentionsService(repo, dataSource);

    const dateFrom = new Date('2026-08-01T00:00:00Z');
    const dateTo = new Date('2026-08-31T23:59:59Z');
    const result = await service.findRecent({
      limit: 25,
      offset: 0,
      sentiment: Sentiment.POSITIVE,
      sourceId: 'src-1',
      sourceType: 'news' as Mention['sourceType'],
      language: 'ru',
      search: 'QazCloud',
      dateFrom,
      dateTo,
    });

    expect(result).toEqual({ items: [{ id: 'm-1' }], total: 1 });
    expect(qb.andWhere).toHaveBeenCalledWith('m.sentiment = :sentiment', { sentiment: Sentiment.POSITIVE });
    expect(qb.andWhere).toHaveBeenCalledWith('m.sourceId = :sourceId', { sourceId: 'src-1' });
    expect(qb.andWhere).toHaveBeenCalledWith('m.sourceType = :sourceType', { sourceType: 'news' });
    expect(qb.andWhere).toHaveBeenCalledWith('m.language = :language', { language: 'ru' });
    expect(qb.andWhere).toHaveBeenCalledWith('(m.title ILIKE :search OR m.text ILIKE :search)', { search: '%QazCloud%' });
    expect(qb.andWhere).toHaveBeenCalledWith('COALESCE(m.publishedAt, m.foundAt) >= :dateFrom', { dateFrom });
    expect(qb.andWhere).toHaveBeenCalledWith('COALESCE(m.publishedAt, m.foundAt) <= :dateTo', { dateTo });
    expect(qb.take).toHaveBeenCalledWith(25);
    expect(qb.skip).toHaveBeenCalledWith(0);
  });

  it('findRecent adds no filter clauses when none are given (back-compat: limit/offset only)', async () => {
    const qb = makeQueryBuilderMock();
    const repo = { createQueryBuilder: jest.fn(() => qb) } as unknown as Repository<Mention>;
    const dataSource = {} as unknown as DataSource;
    const service = new MentionsService(repo, dataSource);

    await service.findRecent({ limit: 50, offset: 0 });

    expect(qb.andWhere).not.toHaveBeenCalled();
  });

  it('getStats computes total, previousTotal, changePercent, byDay, bySentiment and topSources', async () => {
    const totalQb = makeQueryBuilderMock({ getCount: jest.fn(async () => 12) });
    const previousQb = makeQueryBuilderMock({ getCount: jest.fn(async () => 8) });
    const byDayQb = makeQueryBuilderMock({
      getRawMany: jest.fn(async () => [
        { date: '2026-09-01', count: '5' },
        { date: '2026-09-02', count: '7' },
      ]),
    });
    const bySentimentQb = makeQueryBuilderMock({
      getRawMany: jest.fn(async () => [
        { sentiment: Sentiment.POSITIVE, count: '9' },
        { sentiment: Sentiment.NEGATIVE, count: '3' },
      ]),
    });
    const topSourcesQb = makeQueryBuilderMock({
      getRawMany: jest.fn(async () => [{ sourceId: 'src-1', name: 'tengrinews.kz', count: '10' }]),
    });
    const queue = [totalQb, previousQb, byDayQb, bySentimentQb, topSourcesQb];
    const repo = { createQueryBuilder: jest.fn(() => queue.shift()) } as unknown as Repository<Mention>;
    const dataSource = {} as unknown as DataSource;
    const service = new MentionsService(repo, dataSource);

    const dateFrom = new Date('2026-09-01T00:00:00Z');
    const dateTo = new Date('2026-09-08T00:00:00Z');
    const stats = await service.getStats({ dateFrom, dateTo });

    expect(stats.total).toBe(12);
    expect(stats.previousTotal).toBe(8);
    expect(stats.changePercent).toBe(50); // (12 - 8) / 8 * 100
    expect(stats.byDay).toEqual([
      { date: '2026-09-01', count: 5 },
      { date: '2026-09-02', count: 7 },
    ]);
    expect(stats.bySentiment).toEqual({ positive: 9, negative: 3, neutral: 0, undefined: 0 });
    expect(stats.topSources).toEqual([{ sourceId: 'src-1', name: 'tengrinews.kz', count: 10 }]);

    // The "previous" period is the same duration, immediately before dateFrom.
    const durationMs = dateTo.getTime() - dateFrom.getTime();
    expect(previousQb.andWhere).toHaveBeenCalledWith('COALESCE(m.publishedAt, m.foundAt) >= :dateFrom', {
      dateFrom: new Date(dateFrom.getTime() - durationMs - 1),
    });
    expect(previousQb.andWhere).toHaveBeenCalledWith('COALESCE(m.publishedAt, m.foundAt) <= :dateTo', {
      dateTo: new Date(dateFrom.getTime() - 1),
    });
  });

  it('getStats returns changePercent = null when the previous period had zero mentions (avoids division by zero)', async () => {
    const queue = [
      makeQueryBuilderMock({ getCount: jest.fn(async () => 5) }),
      makeQueryBuilderMock({ getCount: jest.fn(async () => 0) }),
      makeQueryBuilderMock(),
      makeQueryBuilderMock(),
      makeQueryBuilderMock(),
    ];
    const repo = { createQueryBuilder: jest.fn(() => queue.shift()) } as unknown as Repository<Mention>;
    const dataSource = {} as unknown as DataSource;
    const service = new MentionsService(repo, dataSource);

    const stats = await service.getStats({
      dateFrom: new Date('2026-09-01T00:00:00Z'),
      dateTo: new Date('2026-09-08T00:00:00Z'),
    });

    expect(stats.total).toBe(5);
    expect(stats.previousTotal).toBe(0);
    expect(stats.changePercent).toBeNull();
  });
});