/**
 * The optional top-up pass inside CuratedSearchService.search() (CURATED_LAZY_PROCESS).
 *
 * It is unreachable from the Telegram bot now: /search and /status read CuratedJsonSearchService,
 * which has no ingest collaborator at all (see telegram-bot.service.spec.ts). What is tested here
 * is the pass as the CLI scripts can still hit it, and its contract is mostly about what it must
 * NOT do — run at all without an OpenAI key, overrun the time budget, waste a call on an article
 * that cannot appear in the requested period, or break the DB read it runs in front of.
 */
import { ConfigService } from '@nestjs/config';
import { Repository } from 'typeorm';
import { CuratedSearchService } from './curated-search.service';
import { CuratedIngestService } from './curated-ingest.service';
import { CuratedLink, CuratedLinkStatus } from './curated-link.entity';
import { Mention } from '../mentions/mention.entity';

const NOW = new Date('2026-09-22T07:00:00Z');

function makeConfig(overrides: Record<string, unknown> = {}): ConfigService {
  const values: Record<string, unknown> = {
    'curated.timezone': 'Asia/Almaty',
    'curated.lazyProcess': true,
    'curated.lazyMaxLinks': 10,
    'curated.lazyBudgetMs': 20000,
    // The pass needs both the flag AND a key; the tests below that exercise processing supply one.
    'openaiSocialSearch.apiKey': 'sk-test',
    ...overrides,
  };
  return { get: jest.fn((key: string) => values[key]) } as unknown as ConfigService;
}

/** Repos that answer every query with empty results — search() itself is covered elsewhere. */
function makeEmptyRepos(): { mentions: Repository<Mention>; links: Repository<CuratedLink> } {
  const qb: Record<string, unknown> = {};
  for (const method of ['where', 'andWhere', 'select', 'addSelect', 'groupBy', 'orderBy', 'addOrderBy', 'offset', 'limit']) {
    qb[method] = jest.fn(() => qb);
  }
  qb.getCount = jest.fn().mockResolvedValue(0);
  qb.getRawMany = jest.fn().mockResolvedValue([]);
  qb.getRawOne = jest.fn().mockResolvedValue({});
  qb.getMany = jest.fn().mockResolvedValue([]);

  const repo = { createQueryBuilder: jest.fn(() => qb), count: jest.fn().mockResolvedValue(0) };
  return { mentions: repo as unknown as Repository<Mention>, links: repo as unknown as Repository<CuratedLink> };
}

function makeLink(id: string, url: string): CuratedLink {
  return {
    id,
    url,
    urlHash: id.padEnd(64, '0'),
    host: 'example.com',
    groupLabel: 'g',
    status: CuratedLinkStatus.PENDING,
    attempts: 0,
    lastError: null,
    dateSource: null,
    mentionId: null,
    lastAttemptAt: null,
    processedAt: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
  } as CuratedLink;
}

function makeIngest(candidates: CuratedLink[], processLink = jest.fn().mockResolvedValue({})): CuratedIngestService {
  return {
    findLazyCandidates: jest.fn().mockResolvedValue(candidates),
    buildContext: jest.fn().mockResolvedValue({ companyForms: [], sourceId: 's', keywordSet: {}, hostQueue: {} }),
    processLink,
  } as unknown as CuratedIngestService;
}

function makeService(config: ConfigService, ingest: CuratedIngestService): CuratedSearchService {
  const repos = makeEmptyRepos();
  return new CuratedSearchService(repos.mentions, repos.links, config, ingest);
}

describe('Ленивая дообработка в /search', () => {
  it('ничего не обрабатывает, пока CURATED_LAZY_PROCESS не включён', async () => {
    const processLink = jest.fn();
    const ingest = makeIngest([makeLink('l1', 'https://example.com/a')], processLink);
    const service = makeService(makeConfig({ 'curated.lazyProcess': false }), ingest);

    await service.search(30, NOW);

    expect(ingest.findLazyCandidates).not.toHaveBeenCalled();
    expect(processLink).not.toHaveBeenCalled();
  });

  it('ничего не обрабатывает без OPENAI_API_KEY, даже когда флаг включён', async () => {
    // Без ключа processLink() не смог бы определить ни дату, ни тональность: каждая ссылка
    // получила бы +1 попытку и статус failed. Честный ответ — не делать ничего.
    const processLink = jest.fn();
    const ingest = makeIngest([makeLink('l1', 'https://example.com/a')], processLink);
    const service = makeService(makeConfig({ 'openaiSocialSearch.apiKey': '' }), ingest);

    const result = await service.search(30, NOW);

    expect(ingest.findLazyCandidates).not.toHaveBeenCalled();
    expect(processLink).not.toHaveBeenCalled();
    expect(result.periodDays).toBe(30);
  });

  it('обрабатывает ожидающие ссылки перед чтением из БД', async () => {
    const processLink = jest.fn().mockResolvedValue({});
    const ingest = makeIngest(
      [makeLink('l1', 'https://example.com/a'), makeLink('l2', 'https://example.com/b')],
      processLink,
    );
    const service = makeService(makeConfig(), ingest);

    await service.search(30, NOW);

    expect(processLink).toHaveBeenCalledTimes(2);
  });

  it('не берёт больше CURATED_LAZY_MAX_LINKS ссылок за один вызов', async () => {
    const processLink = jest.fn().mockResolvedValue({});
    const links = Array.from({ length: 12 }, (_, i) => makeLink(`l${i}`, `https://example.com/a${i}`));
    const service = makeService(makeConfig({ 'curated.lazyMaxLinks': 3 }), makeIngest(links, processLink));

    await service.search(30, NOW);

    expect(processLink).toHaveBeenCalledTimes(3);
  });

  it('пропускает ссылку, дата которой видна в URL и старше запрошенного периода', async () => {
    // Такая статья не попадёт в выдачу ни при какой тональности — платить за неё сейчас незачем.
    const processLink = jest.fn().mockResolvedValue({});
    const old = makeLink('old', 'https://example.com/2020-03-31/very-old-article');
    const fresh = makeLink('fresh', 'https://example.com/2026-09-20/fresh-article');
    const service = makeService(makeConfig(), makeIngest([old, fresh], processLink));

    await service.search(7, NOW);

    expect(processLink).toHaveBeenCalledTimes(1);
    expect(processLink.mock.calls[0][0].id).toBe('fresh');
  });

  it('обрабатывает ссылку без даты в URL — про неё ничего не известно заранее', async () => {
    const processLink = jest.fn().mockResolvedValue({});
    const undated = makeLink('undated', 'https://example.com/news/view/some-slug');
    const service = makeService(makeConfig(), makeIngest([undated], processLink));

    await service.search(7, NOW);

    expect(processLink).toHaveBeenCalledTimes(1);
  });

  it('за длинный период берёт и старую ссылку тоже', async () => {
    const processLink = jest.fn().mockResolvedValue({});
    const old = makeLink('old', 'https://example.com/2020-03-31/very-old-article');
    const service = makeService(makeConfig(), makeIngest([old], processLink));

    await service.search(3650, NOW);

    expect(processLink).toHaveBeenCalledTimes(1);
  });

  it('не начинает новую ссылку после исчерпания бюджета', async () => {
    const processLink = jest.fn().mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    const links = Array.from({ length: 5 }, (_, i) => makeLink(`l${i}`, `https://example.com/a${i}`));
    const service = makeService(makeConfig({ 'curated.lazyBudgetMs': 50 }), makeIngest(links, processLink));

    await service.search(30, NOW);

    // Бюджета в 50 мс при 30 мс на ссылку хватает на две, но заведомо не на все пять.
    expect(processLink.mock.calls.length).toBeGreaterThan(0);
    expect(processLink.mock.calls.length).toBeLessThan(5);
  });

  it('ошибка дообработки не ломает чтение из БД', async () => {
    const processLink = jest.fn().mockRejectedValue(new Error('OpenAI недоступен'));
    const service = makeService(makeConfig(), makeIngest([makeLink('l1', 'https://example.com/a')], processLink));

    const result = await service.search(30, NOW);

    expect(result.periodDays).toBe(30);
    expect(result.total).toBe(0);
  });

  it('недоступная БД при выборе кандидатов тоже не ломает /search', async () => {
    const ingest = {
      findLazyCandidates: jest.fn().mockRejectedValue(new Error('connection refused')),
      buildContext: jest.fn(),
      processLink: jest.fn(),
    } as unknown as CuratedIngestService;
    const service = makeService(makeConfig(), ingest);

    await expect(service.search(30, NOW)).resolves.toMatchObject({ periodDays: 30 });
  });
});
