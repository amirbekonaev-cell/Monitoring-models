import { Repository } from 'typeorm';
import { Sentiment } from '../mentions/mention.entity';
import { Setting } from '../settings/setting.entity';
import { LiveFind } from './live-find.types';
import { LiveFindStoreService } from './live-find-store.service';

const NOW = new Date('2026-09-20T12:00:00Z');

function find(overrides: Partial<LiveFind> = {}): LiveFind {
  return {
    title: 'QazCloud открыл дата-центр',
    url: 'https://tengrinews.kz/news/1/',
    publishedAt: new Date('2026-09-19T10:00:00Z'),
    sourceName: 'Tengrinews',
    domain: 'tengrinews.kz',
    summary: 'Пересказ статьи.',
    sentiment: Sentiment.POSITIVE,
    ...overrides,
  };
}

/** Таблица `settings` в памяти: upsert по ключу и чтение по нему же. */
function makeRepo(seed: Record<string, string> = {}) {
  const rows = new Map<string, string>(Object.entries(seed));
  return {
    rows,
    upsert: jest.fn(async (row: { key: string; value: string }) => {
      rows.set(row.key, row.value);
    }),
    findOne: jest.fn(async ({ where }: { where: { key: string } }) =>
      rows.has(where.key) ? ({ key: where.key, value: rows.get(where.key) } as Setting) : null,
    ),
  };
}

describe('LiveFindStoreService', () => {
  it('кладёт находки в одну строку на период и читает их обратно', async () => {
    const repo = makeRepo();
    const service = new LiveFindStoreService(repo as unknown as Repository<Setting>);

    await service.save(7, [find()], NOW);

    expect(repo.upsert).toHaveBeenCalledWith(expect.objectContaining({ key: 'live_finds:7' }), ['key']);
    const stored = await service.load(7);
    expect(stored.finds).toEqual([find()]);
    expect(stored.savedAt).toEqual(NOW);
  });

  /** В хранилище лежит ровно последняя выдача, а не её история. */
  it('новое сохранение заменяет прежние находки целиком', async () => {
    const repo = makeRepo();
    const service = new LiveFindStoreService(repo as unknown as Repository<Setting>);

    await service.save(7, [find(), find({ url: 'https://profit.kz/a/' })], NOW);
    await service.save(7, [find({ url: 'https://forbes.kz/b/' })], NOW);

    expect((await service.load(7)).finds.map((f) => f.url)).toEqual(['https://forbes.kz/b/']);
  });

  it('периоды не мешают друг другу', async () => {
    const repo = makeRepo();
    const service = new LiveFindStoreService(repo as unknown as Repository<Setting>);

    await service.save(7, [find()], NOW);
    await service.save(90, [], NOW);

    expect((await service.load(7)).finds).toHaveLength(1);
    expect((await service.load(90)).finds).toEqual([]);
  });

  it('нет записи — пустой результат, а не ошибка', async () => {
    const service = new LiveFindStoreService(makeRepo() as unknown as Repository<Setting>);
    expect(await service.load(7)).toEqual({ savedAt: null, finds: [] });
  });

  /** Сломанную строку кто-то мог положить руками или оставить прежний формат. */
  it('нечитаемая запись — пустой результат, а не исключение', async () => {
    const repo = makeRepo({ 'live_finds:7': '{сломано' });
    const service = new LiveFindStoreService(repo as unknown as Repository<Setting>);

    await expect(service.load(7)).resolves.toEqual({ savedAt: null, finds: [] });
  });

  /** Падение базы гасит вызывающий (TelegramBotService) — здесь оно должно быть видно. */
  it('ошибку базы пробрасывает наверх', async () => {
    const repo = makeRepo();
    repo.findOne.mockRejectedValue(new Error('no connection to postgres'));
    const service = new LiveFindStoreService(repo as unknown as Repository<Setting>);

    await expect(service.load(7)).rejects.toThrow('no connection');
  });
});
