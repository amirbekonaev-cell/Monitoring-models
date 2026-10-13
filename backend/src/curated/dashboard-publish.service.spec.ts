import { Sentiment } from '../mentions/mention.entity';
import { DashboardPublishService } from './dashboard-publish.service';
import { CuratedMentionView, CuratedSearchResult, CuratedSearchSource, PoolStats, zeroedLinkStatusRecord, zeroedSentimentRecord } from './curated-search.types';

/**
 * Главная логика истории: выдача бота за выбранный период ЗАМЕНЯЕТ содержимое дашборда целиком —
 * старые упоминания удаляются, новые вставляются, и то и другое в одной транзакции.
 *
 * Поэтому проверяются ровно четыре вещи: что удаление идёт перед вставкой, что вставляется именно
 * то, что бот показал (и в том же виде), что материал без публичной ссылки туда не попадает, и
 * что неудачные сценарии (пустая выдача, упавшая база) ведут себя предсказуемо.
 */

interface RecordedInsert {
  rows: Record<string, unknown>[];
}

/**
 * Поддельный репозиторий поверх минимума из QueryBuilder, которым пользуется сервис. Ровно это и
 * надо проверить без Postgres: порядок операций и содержимое строк. Отдельно пишется журнал
 * вызовов (`calls`) — без него «удалили перед вставкой» не отличить от «вставили перед удалением».
 */
function createRepoStub(options: { deleted?: number; failInsert?: boolean } = {}) {
  const calls: string[] = [];
  const inserts: RecordedInsert[] = [];
  let transactionRolledBack = false;

  const queryBuilder = () => ({
    delete: () => ({
      from: () => ({
        execute: async () => {
          calls.push('delete');
          return { affected: options.deleted ?? 0 };
        },
      }),
    }),
    insert: () => ({
      into: () => ({
        values: (rows: Record<string, unknown>[]) => ({
          execute: async () => {
            calls.push('insert');
            if (options.failInsert) {
              throw new Error('insert failed');
            }
            inserts.push({ rows });
            return {};
          },
        }),
      }),
    }),
  });

  const manager = {
    createQueryBuilder: queryBuilder,
    transaction: async <T>(work: (m: typeof manager) => Promise<T>): Promise<T> => {
      try {
        return await work(manager);
      } catch (error) {
        transactionRolledBack = true;
        throw error;
      }
    },
  };

  return {
    repo: {
      manager,
      createQueryBuilder: queryBuilder,
      count: async () => 0,
    } as never,
    calls,
    inserts,
    get rolledBack() {
      return transactionRolledBack;
    },
  };
}

function poolStats(total: number): PoolStats {
  return {
    totalLinks: total,
    byStatus: zeroedLinkStatusRecord(),
    mentionsTotal: total,
    undatedMentions: 0,
    firstArticleDate: null,
    lastArticleDate: null,
    lastProcessedAt: null,
  };
}

function view(overrides: Partial<CuratedMentionView> & { id: string }): CuratedMentionView {
  return {
    title: `Статья ${overrides.id}`,
    sourceLabel: 'SK News',
    publishedAt: new Date('2026-08-18T12:00:00Z'),
    sentiment: Sentiment.POSITIVE,
    summary: 'Пересказ материала.',
    snippet: null,
    url: `https://sknews.kz/${overrides.id}`,
    ...overrides,
  };
}

/** Источник выдачи: отдаёт заранее заданные карточки и запоминает, с какими аргументами спросили. */
function createSourceStub(items: CuratedMentionView[]): CuratedSearchSource & { askedFor: number[] } {
  const askedFor: number[] = [];
  const result: CuratedSearchResult = {
    periodDays: 0,
    dateFrom: '2026-07-10',
    dateTo: '2026-10-10',
    total: items.length,
    bySentiment: zeroedSentimentRecord(),
    undatedCount: 0,
    pool: poolStats(items.length),
  };
  return {
    askedFor,
    async search(periodDays: number): Promise<CuratedSearchResult> {
      askedFor.push(periodDays);
      return { ...result, periodDays };
    },
    async findPage(_periodDays: number, offset: number, limit: number): Promise<CuratedMentionView[]> {
      return items.slice(offset, offset + limit);
    },
    async getPoolStats(): Promise<PoolStats> {
      return poolStats(items.length);
    },
  };
}

describe('DashboardPublishService.publish', () => {
  it('удаляет прежние упоминания и вставляет выдачу за период — именно в таком порядке', async () => {
    const stub = createRepoStub({ deleted: 42 });
    const source = createSourceStub([view({ id: '1.1' }), view({ id: '1.2' })]);
    const service = new DashboardPublishService(stub.repo, source);

    const outcome = await service.publish(90, new Date('2026-10-10T09:00:00Z'));

    expect(stub.calls).toEqual(['delete', 'insert']);
    expect(outcome).toEqual({
      periodDays: 90,
      dateFrom: '2026-07-10',
      dateTo: '2026-10-10',
      removed: 42,
      published: 2,
    });
    // Спрошено ровно то окно, которое нажал пользователь: иначе дашборд разошёлся бы с сообщением.
    expect(source.askedFor).toEqual([90]);
  });

  it('переносит карточку в том виде, в каком её показал бот', async () => {
    const stub = createRepoStub();
    const source = createSourceStub([
      view({ id: '3.7', title: 'QazCloud открыл ЦОД', sourceLabel: 'Profit.kz', sentiment: Sentiment.NEUTRAL }),
    ]);
    const service = new DashboardPublishService(stub.repo, source);

    await service.publish(30, new Date('2026-10-10T09:00:00Z'));

    const row = stub.inserts[0].rows[0];
    expect(row).toMatchObject({
      title: 'QazCloud открыл ЦОД',
      text: 'Пересказ материала.',
      summary: 'Пересказ материала.',
      url: 'https://sknews.kz/3.7',
      sourceId: null,
      sourceLabel: 'Profit.kz',
      sentiment: Sentiment.NEUTRAL,
      // Тональность написана человеком — фоновый классификатор не должен её трогать.
      sentimentManual: true,
      // Ссылка публичная: в ленте заголовок обязан быть кликабельным.
      urlHidden: false,
      curatedLinkId: null,
    });
    // hash — UNIQUE varchar(64); одна карточка обязана давать ровно одну строку.
    expect(row.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('даёт одной и той же карточке один и тот же hash при повторной публикации', async () => {
    const source = createSourceStub([view({ id: '5.2' })]);

    const first = createRepoStub();
    await new DashboardPublishService(first.repo, source).publish(30);
    const second = createRepoStub();
    await new DashboardPublishService(second.repo, source).publish(30);

    expect(first.inserts[0].rows[0].hash).toBe(second.inserts[0].rows[0].hash);
  });

  it('не публикует материал без публичной ссылки (закрытый пул отдаёт url = null)', async () => {
    const stub = createRepoStub();
    const source = createSourceStub([view({ id: '1.1' }), view({ id: '1.2', url: null }), view({ id: '1.3', url: '  ' })]);
    const service = new DashboardPublishService(stub.repo, source);

    const outcome = await service.publish(365);

    expect(outcome.published).toBe(1);
    expect(stub.inserts[0].rows).toHaveLength(1);
    expect(stub.inserts[0].rows[0].url).toBe('https://sknews.kz/1.1');
  });

  it('пустая выдача: дашборд очищается, вставки не происходит', async () => {
    const stub = createRepoStub({ deleted: 7 });
    const service = new DashboardPublishService(stub.repo, createSourceStub([]));

    const outcome = await service.publish(7);

    expect(outcome.published).toBe(0);
    expect(outcome.removed).toBe(7);
    expect(stub.calls).toEqual(['delete']);
  });

  it('упавшая вставка откатывает транзакцию и пробрасывает ошибку — прежняя выдача остаётся на месте', async () => {
    const stub = createRepoStub({ deleted: 5, failInsert: true });
    const service = new DashboardPublishService(stub.repo, createSourceStub([view({ id: '2.1' })]));

    await expect(service.publish(30)).rejects.toThrow('insert failed');
    expect(stub.rolledBack).toBe(true);
  });
});

/**
 * Находки живого поиска в дашборде. Человек получил в Telegram ОДИН список, и веб-интерфейс
 * обязан показывать тот же: иначе статья, которую бот только что прислал, в ленте отсутствует.
 */
describe('DashboardPublishService.publish — находки живого поиска', () => {
  it('публикует находку наравне с карточками набора', async () => {
    const stub = createRepoStub();
    const source = createSourceStub([view({ id: '1.1' })]);
    const service = new DashboardPublishService(stub.repo, source);

    const outcome = await service.publish(
      90,
      new Date('2026-10-10T09:00:00Z'),
      [view({ id: 'live:tengrinews.kz', title: 'Найденная статья', url: 'https://tengrinews.kz/news/1/' })],
    );

    expect(outcome.published).toBe(2);
    const titles = stub.inserts.flatMap((insert) => insert.rows.map((row) => row.title));
    expect(titles).toEqual(expect.arrayContaining(['Найденная статья', 'Статья 1.1']));
  });

  /** Одна статья — одна карточка в ленте, даже если находка повторяет материал набора. */
  it('схлопывает находку, которая уже есть в наборе, по адресу', async () => {
    const stub = createRepoStub();
    const source = createSourceStub([view({ id: '1.1', url: 'https://sknews.kz/1.1' })]);
    const service = new DashboardPublishService(stub.repo, source);

    const outcome = await service.publish(
      90,
      new Date('2026-10-10T09:00:00Z'),
      [view({ id: 'live:sknews.kz', title: 'Та же статья', url: 'https://sknews.kz/1.1?utm_source=x' })],
    );

    expect(outcome.published).toBe(1);
  });

  it('без находок публикует ровно то же, что и раньше', async () => {
    const stub = createRepoStub();
    const source = createSourceStub([view({ id: '1.1' })]);
    const service = new DashboardPublishService(stub.repo, source);

    expect((await service.publish(90, new Date('2026-10-10T09:00:00Z'))).published).toBe(1);
  });
});

describe('DashboardPublishService.clear', () => {
  it('удаляет все упоминания и возвращает их число', async () => {
    const stub = createRepoStub({ deleted: 167 });
    const service = new DashboardPublishService(stub.repo, createSourceStub([]));

    await expect(service.clear()).resolves.toBe(167);
    expect(stub.calls).toEqual(['delete']);
  });
});
