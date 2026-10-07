import { ConfigService } from '@nestjs/config';
import { Repository } from 'typeorm';
import { CuratedIngestService } from './curated-ingest.service';
import { CuratedSearchService } from './curated-search.service';
import { Mention, Sentiment } from '../mentions/mention.entity';
import { CuratedLink, CuratedLinkStatus } from './curated-link.entity';

/**
 * A minimal in-memory stand-in for TypeORM's QueryBuilder, covering exactly the operations
 * CuratedSearchService issues (see that file): `.where`/`.andWhere` build up a JS predicate over
 * plain row objects instead of real SQL, `.getCount`/`.getRawMany`/`.getRawOne`/`.getMany` apply it.
 * This exercises the *real* service code (real WHERE-clause strings, real params) against
 * hand-computed expected results — not a reimplementation of the service's own logic.
 */
function almatyDateStr(date: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

interface FakeMentionRow {
  id: string;
  curatedLinkId: string | null;
  publishedAt: Date | null;
  sentiment: Sentiment;
  title: string;
  sourceLabel: string | null;
  summary: string | null;
  text: string | null;
}

function makeFakeMentionsRepo(rows: FakeMentionRow[]): Repository<Mention> {
  const createQueryBuilder = jest.fn(() => {
    let predicate: (r: FakeMentionRow) => boolean = () => true;
    const orderBy: Array<['publishedAt' | 'id', 'ASC' | 'DESC']> = [];
    let offsetN = 0;
    let limitN: number | undefined;

    const applyCondition = (cond: string, params?: Record<string, unknown>) => {
      const prev = predicate;
      if (cond.includes('curatedLinkId IS NOT NULL')) {
        predicate = (r) => prev(r) && r.curatedLinkId !== null;
      } else if (cond.includes('publishedAt IS NOT NULL')) {
        predicate = (r) => prev(r) && r.publishedAt !== null;
      } else if (cond.includes('publishedAt IS NULL')) {
        predicate = (r) => prev(r) && r.publishedAt === null;
      } else if (cond.includes('BETWEEN')) {
        const { tz, dateFrom, dateTo } = params as { tz: string; dateFrom: string; dateTo: string };
        predicate = (r) => {
          if (!prev(r) || !r.publishedAt) return false;
          const d = almatyDateStr(r.publishedAt, tz);
          return d >= dateFrom && d <= dateTo;
        };
      } else {
        throw new Error(`Fake query builder: unrecognized condition "${cond}"`);
      }
    };

    const builder: any = {
      where: (cond: string, params?: any) => {
        applyCondition(cond, params);
        return builder;
      },
      andWhere: (cond: string, params?: any) => {
        applyCondition(cond, params);
        return builder;
      },
      select: () => builder,
      addSelect: () => builder,
      groupBy: () => builder,
      orderBy: (field: string, dir: 'ASC' | 'DESC') => {
        orderBy.push([field.endsWith('id') ? 'id' : 'publishedAt', dir]);
        return builder;
      },
      addOrderBy: (field: string, dir: 'ASC' | 'DESC') => {
        orderBy.push([field.endsWith('id') ? 'id' : 'publishedAt', dir]);
        return builder;
      },
      offset: (n: number) => {
        offsetN = n;
        return builder;
      },
      limit: (n: number) => {
        limitN = n;
        return builder;
      },
      getCount: async () => rows.filter(predicate).length,
      getRawMany: async () => {
        const groups = new Map<string, number>();
        for (const r of rows.filter(predicate)) {
          groups.set(r.sentiment, (groups.get(r.sentiment) ?? 0) + 1);
        }
        return Array.from(groups.entries()).map(([sentiment, count]) => ({ sentiment, count: String(count) }));
      },
      getRawOne: async () => {
        const dated = rows.filter(predicate).filter((r) => r.publishedAt);
        if (dated.length === 0) return { first: null, last: null };
        const times = dated.map((r) => r.publishedAt!.getTime());
        return { first: new Date(Math.min(...times)), last: new Date(Math.max(...times)) };
      },
      getMany: async () => {
        const filtered = rows.filter(predicate).slice();
        filtered.sort((a, b) => {
          for (const [field, dir] of orderBy) {
            let cmp: number;
            if (field === 'publishedAt') {
              cmp = (a.publishedAt?.getTime() ?? 0) - (b.publishedAt?.getTime() ?? 0);
            } else {
              cmp = a.id.localeCompare(b.id);
            }
            if (dir === 'DESC') cmp = -cmp;
            if (cmp !== 0) return cmp;
          }
          return 0;
        });
        const end = limitN !== undefined ? offsetN + limitN : undefined;
        return filtered.slice(offsetN, end) as unknown as Mention[];
      },
    };
    return builder;
  });

  return { createQueryBuilder } as unknown as Repository<Mention>;
}

interface FakeCuratedLinkRow {
  status: CuratedLinkStatus;
  processedAt: Date | null;
}

function makeFakeCuratedLinksRepo(rows: FakeCuratedLinkRow[]): Repository<CuratedLink> {
  const count = jest.fn(async () => rows.length);
  const createQueryBuilder = jest.fn(() => {
    const builder: any = {
      select: () => builder,
      addSelect: () => builder,
      groupBy: () => builder,
      getRawMany: async () => {
        const groups = new Map<string, number>();
        for (const r of rows) groups.set(r.status, (groups.get(r.status) ?? 0) + 1);
        return Array.from(groups.entries()).map(([status, c]) => ({ status, count: String(c) }));
      },
      getRawOne: async () => {
        const dates = rows.map((r) => r.processedAt).filter((d): d is Date => d !== null);
        return { lastProcessedAt: dates.length ? new Date(Math.max(...dates.map((d) => d.getTime()))) : null };
      },
    };
    return builder;
  });
  return { count, createQueryBuilder } as unknown as Repository<CuratedLink>;
}

function makeConfig(overrides: Record<string, unknown> = {}): ConfigService {
  const values: Record<string, unknown> = { 'curated.timezone': 'Asia/Almaty', ...overrides };
  return { get: jest.fn((key: string) => values[key]) } as unknown as ConfigService;
}

/**
 * The lazy top-up collaborator (CURATED_LAZY_PROCESS). makeConfig() leaves the flag unset, so
 * search() returns from lazyProcess() before touching this — these tests are about the DB read.
 * The lazy pass has its own tests in curated-lazy-process.spec.ts.
 */
function makeIngest(): CuratedIngestService {
  return {
    findLazyCandidates: jest.fn().mockResolvedValue([]),
    buildContext: jest.fn(),
    processLink: jest.fn(),
  } as unknown as CuratedIngestService;
}

function mention(overrides: Partial<FakeMentionRow>): FakeMentionRow {
  return {
    id: 'm-1',
    curatedLinkId: 'link-1',
    publishedAt: null,
    sentiment: Sentiment.UNDEFINED,
    title: 'Заголовок',
    sourceLabel: null,
    summary: null,
    text: null,
    ...overrides,
  };
}

describe('CuratedSearchService.search', () => {
  // "now" pinned at 2026-09-16 12:00 Almaty time (07:00Z) so a 7-day window is 2026-09-09..2026-09-16.
  const now = new Date('2026-09-16T07:00:00Z');

  it('counts only dated mentions produced by the pool, inside the calendar window', async () => {
    const mentionsRepo = makeFakeMentionsRepo([
      mention({ id: 'a', publishedAt: new Date('2026-09-10T10:00:00Z') }), // in window
      mention({ id: 'b', publishedAt: new Date('2026-09-01T10:00:00Z') }), // before window
      mention({ id: 'c', curatedLinkId: null, publishedAt: new Date('2026-09-10T10:00:00Z') }), // not from the pool
    ]);
    const curatedLinksRepo = makeFakeCuratedLinksRepo([]);
    const service = new CuratedSearchService(mentionsRepo, curatedLinksRepo, makeConfig(), makeIngest());

    const result = await service.search(7, now);

    expect(result.total).toBe(1);
    expect(result.dateFrom).toBe('2026-09-09');
    expect(result.dateTo).toBe('2026-09-16');
  });

  it('excludes a future-dated mention from the window', async () => {
    const mentionsRepo = makeFakeMentionsRepo([mention({ id: 'future', publishedAt: new Date('2026-09-17T10:00:00Z') })]);
    const service = new CuratedSearchService(mentionsRepo, makeFakeCuratedLinksRepo([]), makeConfig(), makeIngest());

    const result = await service.search(7, now);

    expect(result.total).toBe(0);
  });

  it('counts an undated pool mention in undatedCount, never in total, regardless of period', async () => {
    const mentionsRepo = makeFakeMentionsRepo([
      mention({ id: 'undated', publishedAt: null }),
      mention({ id: 'dated', publishedAt: new Date('2026-09-10T10:00:00Z') }),
    ]);
    const service = new CuratedSearchService(mentionsRepo, makeFakeCuratedLinksRepo([]), makeConfig(), makeIngest());

    const result = await service.search(1, now); // 1-day window wouldn't even cover 'dated'

    expect(result.undatedCount).toBe(1);
    expect(result.total).toBe(0);
  });

  it('breaks totals down by sentiment', async () => {
    const mentionsRepo = makeFakeMentionsRepo([
      mention({ id: 'a', publishedAt: new Date('2026-09-10T10:00:00Z'), sentiment: Sentiment.POSITIVE }),
      mention({ id: 'b', publishedAt: new Date('2026-09-11T10:00:00Z'), sentiment: Sentiment.POSITIVE }),
      mention({ id: 'c', publishedAt: new Date('2026-09-12T10:00:00Z'), sentiment: Sentiment.NEGATIVE }),
    ]);
    const service = new CuratedSearchService(mentionsRepo, makeFakeCuratedLinksRepo([]), makeConfig(), makeIngest());

    const result = await service.search(7, now);

    expect(result.bySentiment[Sentiment.POSITIVE]).toBe(2);
    expect(result.bySentiment[Sentiment.NEGATIVE]).toBe(1);
    expect(result.bySentiment[Sentiment.NEUTRAL]).toBe(0);
    expect(result.bySentiment[Sentiment.UNDEFINED]).toBe(0);
  });

  it('resolves the midnight boundary in Asia/Almaty, not UTC', async () => {
    const mentionsRepo = makeFakeMentionsRepo([
      // 2026-09-08T20:30Z is still "the 8th" in UTC but already "the 9th" 01:30 in Almaty — with
      // dateFrom=2026-09-09 (7-day window from the 16th), this must be INCLUDED (Almaty date is
      // the 9th), even though a naive UTC ::date cast would have excluded it (UTC date is the 8th).
      mention({ id: 'boundary', publishedAt: new Date('2026-09-08T20:30:00Z') }),
    ]);
    const service = new CuratedSearchService(mentionsRepo, makeFakeCuratedLinksRepo([]), makeConfig(), makeIngest());

    const result = await service.search(7, now);

    expect(result.total).toBe(1);
  });

  it('handles a 2-year (N=730) window spanning a leap year', async () => {
    const mentionsRepo = makeFakeMentionsRepo([
      mention({ id: 'old-in-window', publishedAt: new Date('2024-09-20T10:00:00Z') }),
      mention({ id: 'too-old', publishedAt: new Date('2024-09-10T10:00:00Z') }),
    ]);
    const service = new CuratedSearchService(mentionsRepo, makeFakeCuratedLinksRepo([]), makeConfig(), makeIngest());

    const result = await service.search(730, now);

    expect(result.dateFrom).toBe('2024-09-16');
    expect(result.total).toBe(1);
  });

  it('accepts an injected `now` for deterministic tests', async () => {
    const mentionsRepo = makeFakeMentionsRepo([]);
    const service = new CuratedSearchService(mentionsRepo, makeFakeCuratedLinksRepo([]), makeConfig(), makeIngest());

    const result = await service.search(1, new Date('2020-01-01T12:00:00Z'));

    expect(result.dateTo).toBe('2020-01-01');
  });
});

describe('CuratedSearchService.findPage', () => {
  const now = new Date('2026-09-16T07:00:00Z');

  it('sorts by publishedAt DESC, then id ASC as a tiebreaker', async () => {
    const mentionsRepo = makeFakeMentionsRepo([
      mention({ id: 'b', publishedAt: new Date('2026-09-10T10:00:00Z') }),
      mention({ id: 'a', publishedAt: new Date('2026-09-10T10:00:00Z') }), // same instant as 'b' -> id breaks the tie
      mention({ id: 'newest', publishedAt: new Date('2026-09-12T10:00:00Z') }),
    ]);
    const service = new CuratedSearchService(mentionsRepo, makeFakeCuratedLinksRepo([]), makeConfig(), makeIngest());

    const page = await service.findPage(7, 0, 10, now);

    expect(page.map((m) => m.id)).toEqual(['newest', 'a', 'b']);
  });

  it('applies offset and limit', async () => {
    const rows = ['a', 'b', 'c', 'd'].map((id, i) =>
      mention({ id, publishedAt: new Date(`2026-09-1${i}T10:00:00Z`) }),
    );
    const mentionsRepo = makeFakeMentionsRepo(rows);
    const service = new CuratedSearchService(mentionsRepo, makeFakeCuratedLinksRepo([]), makeConfig(), makeIngest());

    const page = await service.findPage(7, 1, 2, now);

    // Full DESC order is d, c, b, a — offset 1, limit 2 -> c, b.
    expect(page.map((m) => m.id)).toEqual(['c', 'b']);
  });

  it('falls back to the default source label and truncates summary/snippet for display', async () => {
    const longSummary = 'Пересказ. '.repeat(40); // > 250 chars
    const longText = 'Текст статьи. '.repeat(40); // > 200 chars
    const mentionsRepo = makeFakeMentionsRepo([
      mention({
        id: 'a',
        publishedAt: new Date('2026-09-10T10:00:00Z'),
        sourceLabel: null,
        summary: longSummary,
        text: longText,
      }),
    ]);
    const service = new CuratedSearchService(mentionsRepo, makeFakeCuratedLinksRepo([]), makeConfig(), makeIngest());

    const [view] = await service.findPage(7, 0, 10, now);

    expect(view.sourceLabel).toBe('Подборка материалов');
    expect(view.summary!.length).toBeLessThan(longSummary.length);
    expect(view.summary!.endsWith('…')).toBe(true);
    expect(view.snippet!.length).toBeLessThan(longText.length);
  });

  // CURATED_SUMMARY_DISPLAY_CHARS. Default 250 is asserted by the test above (which configures
  // nothing); these two cover the knob itself, needed because a ~50-word summary
  // (CURATED_SUMMARY_WORDS) arrives cut mid-sentence under the old 250-character cap.
  it('truncates summary to CURATED_SUMMARY_DISPLAY_CHARS when it is configured', async () => {
    const longSummary = 'я'.repeat(600);
    const mentionsRepo = makeFakeMentionsRepo([
      mention({ id: 'a', publishedAt: new Date('2026-09-10T10:00:00Z'), summary: longSummary }),
    ]);
    const service = new CuratedSearchService(
      mentionsRepo,
      makeFakeCuratedLinksRepo([]),
      makeConfig({ 'curated.summaryDisplayChars': 420 }),
      makeIngest(),
    );

    const [view] = await service.findPage(7, 0, 10, now);

    expect(view.summary).toHaveLength(421); // 420 characters + the ellipsis
  });

  it('keeps the 250-character default when the variable is absent or unusable', async () => {
    const longSummary = 'я'.repeat(600);
    const rows = [mention({ id: 'a', publishedAt: new Date('2026-09-10T10:00:00Z'), summary: longSummary })];

    for (const configured of [undefined, 0, -1, NaN]) {
      const service = new CuratedSearchService(
        makeFakeMentionsRepo(rows),
        makeFakeCuratedLinksRepo([]),
        makeConfig({ 'curated.summaryDisplayChars': configured }),
        makeIngest(),
      );

      const [view] = await service.findPage(7, 0, 10, now);
      expect(view.summary).toHaveLength(251);
    }
  });

  it('excludes mentions with no curated_link_id', async () => {
    const mentionsRepo = makeFakeMentionsRepo([
      mention({ id: 'pool', curatedLinkId: 'link-1', publishedAt: new Date('2026-09-10T10:00:00Z') }),
      mention({ id: 'other-channel', curatedLinkId: null, publishedAt: new Date('2026-09-10T10:00:00Z') }),
    ]);
    const service = new CuratedSearchService(mentionsRepo, makeFakeCuratedLinksRepo([]), makeConfig(), makeIngest());

    const page = await service.findPage(7, 0, 10, now);

    expect(page.map((m) => m.id)).toEqual(['pool']);
  });
});

/**
 * This service is no longer what the bot reads — /search and /status go through
 * CuratedJsonSearchService (curated-json-search.service.spec.ts). It stays as the DB-backed
 * implementation of the same CuratedSearchSource interface, used by the CLI inspection scripts, so
 * the tests below still pin the SQL-level behaviour its callers rely on.
 */
describe('CuratedSearchService как запасной источник (БД)', () => {
  const now = new Date('2026-09-16T07:00:00Z');

  it('не заполняет cards — форматтеры должны выбрать формулировки про пул ссылок, не про набор карточек', async () => {
    const service = new CuratedSearchService(
      makeFakeMentionsRepo([mention({ id: 'a', publishedAt: new Date('2026-09-10T10:00:00Z') })]),
      makeFakeCuratedLinksRepo([{ status: CuratedLinkStatus.PROCESSED, processedAt: new Date('2026-09-16T08:00:00Z') }]),
      makeConfig(),
      makeIngest(),
    );

    const result = await service.search(7, now);
    const stats = await service.getPoolStats();

    expect(result.pool.cards).toBeUndefined();
    expect(stats.cards).toBeUndefined();
    // И по-прежнему отдаёт статусы ссылок — именно их печатает npm run curated:status.
    expect(stats.byStatus[CuratedLinkStatus.PROCESSED]).toBe(1);
    expect(stats.lastProcessedAt).toEqual(new Date('2026-09-16T08:00:00Z'));
  });

  it('реализует тот же контракт из трёх методов, что и JSON-источник', () => {
    const service = new CuratedSearchService(
      makeFakeMentionsRepo([]),
      makeFakeCuratedLinksRepo([]),
      makeConfig(),
      makeIngest(),
    );

    for (const method of ['search', 'findPage', 'getPoolStats'] as const) {
      expect(typeof service[method]).toBe('function');
    }
  });
});

describe('CuratedSearchService.getPoolStats', () => {
  it('aggregates link status counts, mention totals, the dated article range, and last-processed time', async () => {
    const mentionsRepo = makeFakeMentionsRepo([
      mention({ id: 'a', publishedAt: new Date('2020-01-10T00:00:00Z') }),
      mention({ id: 'b', publishedAt: new Date('2026-09-15T00:00:00Z') }),
      mention({ id: 'undated', publishedAt: null }),
      mention({ id: 'not-pool', curatedLinkId: null, publishedAt: new Date('2026-01-01T00:00:00Z') }),
    ]);
    const curatedLinksRepo = makeFakeCuratedLinksRepo([
      { status: CuratedLinkStatus.PROCESSED, processedAt: new Date('2026-09-16T08:00:00Z') },
      { status: CuratedLinkStatus.PROCESSED, processedAt: new Date('2026-09-01T08:00:00Z') },
      { status: CuratedLinkStatus.PENDING, processedAt: null },
      { status: CuratedLinkStatus.FAILED, processedAt: new Date('2026-08-01T08:00:00Z') },
    ]);
    const service = new CuratedSearchService(mentionsRepo, curatedLinksRepo, makeConfig(), makeIngest());

    const stats = await service.getPoolStats();

    expect(stats.totalLinks).toBe(4);
    expect(stats.byStatus[CuratedLinkStatus.PROCESSED]).toBe(2);
    expect(stats.byStatus[CuratedLinkStatus.PENDING]).toBe(1);
    expect(stats.byStatus[CuratedLinkStatus.FAILED]).toBe(1);
    expect(stats.byStatus[CuratedLinkStatus.NOT_RELEVANT]).toBe(0);
    expect(stats.mentionsTotal).toBe(3); // excludes 'not-pool'
    expect(stats.undatedMentions).toBe(1);
    expect(stats.firstArticleDate).toEqual(new Date('2020-01-10T00:00:00Z'));
    expect(stats.lastArticleDate).toEqual(new Date('2026-09-15T00:00:00Z'));
    expect(stats.lastProcessedAt).toEqual(new Date('2026-09-16T08:00:00Z'));
  });

  it('reports null date range and last-processed when the pool is empty', async () => {
    const service = new CuratedSearchService(makeFakeMentionsRepo([]), makeFakeCuratedLinksRepo([]), makeConfig(), makeIngest());

    const stats = await service.getPoolStats();

    expect(stats.totalLinks).toBe(0);
    expect(stats.firstArticleDate).toBeNull();
    expect(stats.lastArticleDate).toBeNull();
    expect(stats.lastProcessedAt).toBeNull();
  });
});
