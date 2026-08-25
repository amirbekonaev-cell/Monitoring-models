import { DataSource, Repository } from 'typeorm';
import { MentionsService } from './mentions.service';
import { Mention } from './mention.entity';

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
});
