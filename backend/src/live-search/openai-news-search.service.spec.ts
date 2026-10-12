import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { Sentiment } from '../mentions/mention.entity';
import { DEFAULT_BRAND_FORMS } from './brand-match.util';
import { OpenAiNewsSearchService } from './openai-news-search.service';

const FORMS = [...DEFAULT_BRAND_FORMS];

function makeConfig(extra: Record<string, unknown> = {}): ConfigService {
  const values: Record<string, unknown> = {
    'openaiSocialSearch.apiKey': 'sk-test',
    'openaiSocialSearch.model': 'gpt-5-mini',
    'liveSearch.openaiEnabled': true,
    'liveSearch.openaiTimeoutMs': 26000,
    ...extra,
  };
  return { get: jest.fn((key: string) => values[key]) } as unknown as ConfigService;
}

/** Ответ API в том виде, в каком его отдаёт Responses API: JSON строкой внутри output_text. */
function apiResponse(items: unknown, billed = 1) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ items }) }] }],
      tool_usage: { web_search: { num_requests: billed } },
    }),
  };
}

function item(overrides: Record<string, unknown> = {}) {
  return {
    title: 'QazCloud открыл дата-центр',
    url: 'https://tengrinews.kz/news/qazcloud-data-center/',
    publication: 'Tengrinews',
    publishedAt: '2026-09-20',
    summary: 'Короткий пересказ статьи.',
    sentiment: 'positive',
    ...overrides,
  };
}

describe('OpenAiNewsSearchService', () => {
  let fetchMock: jest.SpyInstance;
  let warn: jest.SpyInstance;
  let log: jest.SpyInstance;

  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    fetchMock?.mockRestore();
    warn.mockRestore();
    log.mockRestore();
  });

  function stubFetch(response: unknown) {
    fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(response as Response);
    return fetchMock;
  }

  it('разбирает структурированный ответ в находки', async () => {
    stubFetch(apiResponse([item()]));
    const service = new OpenAiNewsSearchService(makeConfig());

    const finds = await service.search(FORMS);

    expect(finds).toHaveLength(1);
    expect(finds[0]).toMatchObject({
      title: 'QazCloud открыл дата-центр',
      url: 'https://tengrinews.kz/news/qazcloud-data-center/',
      sourceName: 'Tengrinews',
      domain: 'tengrinews.kz',
      summary: 'Короткий пересказ статьи.',
      sentiment: Sentiment.POSITIVE,
    });
    // Дата статьи — календарный день; полдень UTC, чтобы день не съехал при показе в Алматы.
    expect(finds[0].publishedAt?.toISOString()).toBe('2026-09-20T12:00:00.000Z');
  });

  /**
   * Запреты в промпте — главное, что отличает этот канал от бесполезного: без них тот же ключ и
   * та же модель возвращали сайт самой компании, бизнес-реестры, площадку госзакупок и
   * конкурента вместо новостей. Тест держит их на месте.
   */
  it('просит только журналистские материалы и перечисляет, что исключить', async () => {
    const fetchSpy = stubFetch(apiResponse([]));
    const service = new OpenAiNewsSearchService(makeConfig());

    await service.search(FORMS);

    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
    expect(body.input).toContain('НОВОСТНЫЕ СТАТЬИ');
    expect(body.input).toContain('ИСКЛЮЧИ');
    for (const ban of ['реестр', 'госзакупок', 'конкурент', 'вакансии']) {
      expect(body.input).toContain(ban);
    }
    // Все формы названия уходят в запрос — иначе казахское написание не нашлось бы.
    for (const form of FORMS) {
      expect(body.input).toContain(form);
    }
    expect(body.tools).toEqual([{ type: 'web_search' }]);
    expect(body.text.format.type).toBe('json_schema');
  });

  describe('неудачные сценарии', () => {
    it('без ключа канал выключен и запрос не уходит', async () => {
      const fetchSpy = stubFetch(apiResponse([item()]));
      const service = new OpenAiNewsSearchService(makeConfig({ 'openaiSocialSearch.apiKey': '' }));

      expect(service.available).toBe(false);
      expect(await service.search(FORMS)).toEqual([]);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('выключенный канал запрос не делает', async () => {
      const fetchSpy = stubFetch(apiResponse([item()]));
      const service = new OpenAiNewsSearchService(makeConfig({ 'liveSearch.openaiEnabled': false }));

      expect(service.available).toBe(false);
      expect(await service.search(FORMS)).toEqual([]);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('ошибка API — исключение с кодом и текстом, чтобы причина попала в лог', async () => {
      stubFetch({ ok: false, status: 429, json: async () => ({ error: { message: 'rate limit' } }) });
      const service = new OpenAiNewsSearchService(makeConfig());

      await expect(service.search(FORMS)).rejects.toThrow('HTTP 429');
      await expect(service.search(FORMS)).rejects.toThrow('rate limit');
    });

    /** `strict: true` не спасает от обрыва ответа на середине — разбор обязан это выдержать. */
    it('обрезанный JSON — пустая выдача и предупреждение, а не падение', async () => {
      stubFetch({
        ok: true,
        status: 200,
        json: async () => ({ output: [{ type: 'message', content: [{ type: 'output_text', text: '{"items":[{"ti' }] }] }),
      });
      const service = new OpenAiNewsSearchService(makeConfig());

      expect(await service.search(FORMS)).toEqual([]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('не-JSON'));
    });

    it('пустой ответ модели — пустая выдача', async () => {
      stubFetch({ ok: true, status: 200, json: async () => ({ output: [] }) });
      const service = new OpenAiNewsSearchService(makeConfig());

      expect(await service.search(FORMS)).toEqual([]);
    });

    it('исчерпанный бюджет прохода — запрос не уходит вовсе', async () => {
      const fetchSpy = stubFetch(apiResponse([item()]));
      const service = new OpenAiNewsSearchService(makeConfig());

      expect(await service.search(FORMS, Date.now() - 1)).toEqual([]);
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe('чистка выдачи модели', () => {
    it('выбрасывает статьи без ссылки или заголовка', async () => {
      stubFetch(apiResponse([item({ url: '' }), item({ title: '' }), item()]));
      const service = new OpenAiNewsSearchService(makeConfig());

      expect(await service.search(FORMS)).toHaveLength(1);
    });

    /** Ссылка в сообщении должна открываться, поэтому выдуманный адрес не показывается. */
    it('выбрасывает статьи с битым адресом и не-http схемой', async () => {
      stubFetch(apiResponse([item({ url: 'не ссылка' }), item({ url: 'ftp://host/a' }), item()]));
      const service = new OpenAiNewsSearchService(makeConfig());

      const finds = await service.search(FORMS);

      expect(finds).toHaveLength(1);
      expect(finds[0].url).toBe('https://tengrinews.kz/news/qazcloud-data-center/');
    });

    it('дата не в формате ГГГГ-ММ-ДД становится «без даты», а не выдуманным днём', async () => {
      stubFetch(apiResponse([item({ publishedAt: 'недавно' }), item({ url: 'https://a.kz/b', publishedAt: null })]));
      const service = new OpenAiNewsSearchService(makeConfig());

      const finds = await service.search(FORMS);

      expect(finds).toHaveLength(2);
      expect(finds.every((f) => f.publishedAt === null)).toBe(true);
    });

    it('неизвестная тональность — «не определена», а не угадывание', async () => {
      stubFetch(apiResponse([item({ sentiment: 'очень хорошо' })]));
      const service = new OpenAiNewsSearchService(makeConfig());

      expect((await service.search(FORMS))[0].sentiment).toBe(Sentiment.UNDEFINED);
    });

    it('без названия издания подставляет домен', async () => {
      stubFetch(apiResponse([item({ publication: '  ' })]));
      const service = new OpenAiNewsSearchService(makeConfig());

      expect((await service.search(FORMS))[0].sourceName).toBe('tengrinews.kz');
    });
  });
});
