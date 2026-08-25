import { ConfigService } from '@nestjs/config';
import { OpenAiWebSearchService } from './openai-web-search.service';
import { Keyword, KeywordType } from '../../keywords/keyword.entity';

function makeConfig(overrides: Record<string, unknown> = {}): ConfigService {
  const values: Record<string, unknown> = {
    'openaiSocialSearch.apiKey': 'test-key',
    'openaiSocialSearch.model': 'gpt-5-mini',
    ...overrides,
  };
  return { get: (key: string) => values[key] } as unknown as ConfigService;
}

function keyword(phrase: string, manualForms: string[] = []): Keyword {
  return {
    id: 'k1',
    phrase,
    type: KeywordType.REQUIRED,
    isActive: true,
    language: 'ru',
    manualForms,
    createdAt: new Date(),
  };
}

describe('OpenAiWebSearchService', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('throws a clear error when OPENAI_API_KEY is not set', async () => {
    const service = new OpenAiWebSearchService(makeConfig({ 'openaiSocialSearch.apiKey': '' }));
    await expect(service.search([keyword('QazCloud')])).rejects.toThrow(/OPENAI_API_KEY/);
  });

  it('skips the cycle with no active required/exact_phrase keywords', async () => {
    global.fetch = jest.fn() as unknown as typeof fetch;
    const service = new OpenAiWebSearchService(makeConfig());
    const items = await service.search([]);
    expect(items).toEqual([]);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('issues a single unrestricted request (no allowed_domains filter) and extracts items from any domain', async () => {
    const text =
      'На форуме kz-forum.example нашлось упоминание QazCloud в обсуждении облачных провайдеров. ' +
      'Также есть пост в Instagram про QazCloud.';
    const payload = {
      // Real Responses API traffic (verified live) can report a single billed
      // tool_usage.web_search.num_requests while still emitting two web_search_call output
      // items (e.g. 'search' + 'open_page') — the service must trust tool_usage, not count items.
      tool_usage: { web_search: { num_requests: 1 } },
      output: [
        { type: 'web_search_call', id: 'ws_1', status: 'completed', action: { type: 'search' } },
        { type: 'web_search_call', id: 'ws_2', status: 'completed', action: { type: 'open_page' } },
        {
          type: 'message',
          id: 'msg_1',
          role: 'assistant',
          content: [
            {
              type: 'output_text',
              text,
              annotations: [
                {
                  type: 'url_citation',
                  url: 'https://kz-forum.example/thread/123',
                  title: 'Обсуждение облачных провайдеров',
                  start_index: 0,
                  end_index: 40,
                },
                {
                  type: 'url_citation',
                  url: 'https://www.instagram.com/p/abc123/',
                  title: 'QazCloud upominanie',
                  start_index: 41,
                  end_index: 90,
                },
              ],
            },
          ],
        },
      ],
    };

    let capturedBody: Record<string, unknown> = {};
    global.fetch = jest.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe('https://api.openai.com/v1/responses');
      capturedBody = JSON.parse(init.body as string);
      return { ok: true, json: async () => payload };
    }) as unknown as typeof fetch;

    const service = new OpenAiWebSearchService(makeConfig());
    const items = await service.search([keyword('QazCloud')]);

    expect(capturedBody.tools).toEqual([{ type: 'web_search' }]);
    expect(capturedBody.reasoning).toEqual({ effort: 'low' });

    expect(items).toHaveLength(2);
    expect(items[0].url).toBe('https://kz-forum.example/thread/123');
    expect(items[0].sourceLabel).toBe('kz-forum.example');
    expect(items[1].url).toBe('https://www.instagram.com/p/abc123/');
    expect(items[1].sourceLabel).toBe('instagram.com');
  });

  it('widens the snippet to the full line when the citation only spans the inline markdown link', async () => {
    // Verified live against the real API: the model sometimes writes one finding per line
    // ("N) «quote». (link)") but points start_index/end_index at just the trailing
    // "([t.me](url))" marker, not the quote — a raw slice would save an empty/useless mention.
    const text =
      '1) «PR департамент компании QazCloud прокомментировал ситуацию». ([t.me](https://t.me/s/example))\n' +
      '2) Другая находка без отношения к делу.';
    const linkStart = text.indexOf('([t.me]');
    const linkEnd = text.indexOf('))', linkStart) + 2;
    const payload = {
      tool_usage: { web_search: { num_requests: 1 } },
      output: [
        {
          type: 'message',
          id: 'msg_1',
          role: 'assistant',
          content: [
            {
              type: 'output_text',
              text,
              annotations: [
                {
                  type: 'url_citation',
                  url: 'https://t.me/s/example',
                  title: 'Example channel – Telegram',
                  start_index: linkStart,
                  end_index: linkEnd,
                },
              ],
            },
          ],
        },
      ],
    };

    global.fetch = jest.fn(async () => ({ ok: true, json: async () => payload })) as unknown as typeof fetch;

    const service = new OpenAiWebSearchService(makeConfig());
    const items = await service.search([keyword('QazCloud')]);

    expect(items).toHaveLength(1);
    expect(items[0].text).toContain('PR департамент компании QazCloud прокомментировал ситуацию');
    expect(items[0].text).not.toContain('t.me/s/example');
    expect(items[0].sourceLabel).toBe('t.me');
  });

  it('surfaces the OpenAI error message on a non-ok HTTP response', async () => {
    global.fetch = jest.fn(async () => ({
      ok: false,
      status: 401,
      json: async () => ({ error: { message: 'Invalid API key' } }),
    })) as unknown as typeof fetch;

    const service = new OpenAiWebSearchService(makeConfig());
    await expect(service.search([keyword('QazCloud')])).rejects.toThrow(/Invalid API key/);
  });
});