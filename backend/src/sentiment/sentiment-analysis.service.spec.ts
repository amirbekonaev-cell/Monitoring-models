import { ConfigService } from '@nestjs/config';
import { SentimentAnalysisService } from './sentiment-analysis.service';
import { Sentiment } from '../mentions/mention.entity';
import { ParserService } from '../collectors/parser/parser.service';

function makeConfig(overrides: Record<string, unknown> = {}): ConfigService {
  const values: Record<string, unknown> = {
    'sentimentAnalysis.apiKey': 'test-key',
    'sentimentAnalysis.model': 'gpt-5-mini',
    ...overrides,
  };
  return { get: (key: string) => values[key] } as unknown as ConfigService;
}

function makeParserService(): ParserService {
  return { fetchArticleText: jest.fn(async () => null) } as unknown as ParserService;
}

function structuredOutput(payload: { sentiment: string; reason: string; summary: string }) {
  return { output_text: JSON.stringify(payload) };
}

describe('SentimentAnalysisService', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('returns null (leaves Sentiment.UNDEFINED) when OPENAI_API_KEY is not set', async () => {
    const service = new SentimentAnalysisService(makeConfig({ 'sentimentAnalysis.apiKey': '' }), makeParserService());
    const result = await service.classify('Заголовок', 'Текст упоминания');
    expect(result).toBeNull();
  });

  it('classifies a positive mention from structured JSON output_text, including the summary field', async () => {
    global.fetch = jest.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe('https://api.openai.com/v1/responses');
      const body = JSON.parse(init.body as string);
      expect(body.model).toBe('gpt-5-mini');
      expect(body.text.format.type).toBe('json_schema');
      return {
        ok: true,
        json: async () =>
          structuredOutput({
            sentiment: 'positive',
            reason: 'Компания получила положительный отзыв клиента.',
            summary: 'QazCloud получил положительный отзыв.',
          }),
      };
    }) as unknown as typeof fetch;

    const service = new SentimentAnalysisService(makeConfig(), makeParserService());
    const result = await service.classify('QazCloud получил награду', 'Отличная новость для компании достаточно длинный текст статьи');

    expect(result).toEqual({
      sentiment: Sentiment.POSITIVE,
      reason: 'Компания получила положительный отзыв клиента.',
      summary: 'QazCloud получил положительный отзыв.',
    });
  });

  it('classifies a negative mention when the output is nested under output[].content[].text', async () => {
    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({
        output: [
          {
            type: 'message',
            content: [
              {
                type: 'output_text',
                text: JSON.stringify({ sentiment: 'negative', reason: 'Жалоба клиента.', summary: 'Жалоба на сервис.' }),
              },
            ],
          },
        ],
      }),
    })) as unknown as typeof fetch;

    const service = new SentimentAnalysisService(makeConfig(), makeParserService());
    const result = await service.classify('QazCloud подвёл клиента', 'Жалоба на сервис, достаточно длинный текст материала для проверки');

    expect(result?.sentiment).toBe(Sentiment.NEGATIVE);
  });

  it('returns null when the model answer is not valid JSON or has an unrecognised sentiment value', async () => {
    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({ output_text: 'не знаю, сложно сказать' }),
    })) as unknown as typeof fetch;

    const service = new SentimentAnalysisService(makeConfig(), makeParserService());
    const result = await service.classify('Заголовок', 'Текст');

    expect(result).toBeNull();
  });

  it('returns null (permanent error, not thrown) on a non-ok, non-retryable HTTP response', async () => {
    global.fetch = jest.fn(async () => ({
      ok: false,
      status: 401,
      json: async () => ({ error: { message: 'Invalid API key' } }),
    })) as unknown as typeof fetch;

    const service = new SentimentAnalysisService(makeConfig(), makeParserService());
    const result = await service.classify('Заголовок', 'Текст');

    expect(result).toBeNull();
  });

  it('throws (does not swallow) on a 429 rate-limit response — transient, distinguished from a permanent error', async () => {
    global.fetch = jest.fn(async () => ({
      ok: false,
      status: 429,
      json: async () => ({ error: { message: 'Rate limited' } }),
    })) as unknown as typeof fetch;

    const service = new SentimentAnalysisService(makeConfig(), makeParserService());

    await expect(service.classify('Заголовок', 'Текст')).rejects.toThrow('429');
  });

  it('throws on a 5xx server error — transient, distinguished from a permanent error', async () => {
    global.fetch = jest.fn(async () => ({
      ok: false,
      status: 503,
      json: async () => ({ error: { message: 'Service unavailable' } }),
    })) as unknown as typeof fetch;

    const service = new SentimentAnalysisService(makeConfig(), makeParserService());

    await expect(service.classify('Заголовок', 'Текст')).rejects.toThrow('503');
  });

  it('throws on a network/timeout failure — transient, distinguished from a permanent error', async () => {
    global.fetch = jest.fn(async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;

    const service = new SentimentAnalysisService(makeConfig(), makeParserService());

    await expect(service.classify('Заголовок', 'Текст')).rejects.toThrow('network down');
  });

  it('returns null when both title and text are empty', async () => {
    global.fetch = jest.fn() as unknown as typeof fetch;
    const service = new SentimentAnalysisService(makeConfig(), makeParserService());

    const result = await service.classify('', '');

    expect(result).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('fetches the full article text via ParserService when the given text looks like a short teaser', async () => {
    const parserService = {
      fetchArticleText: jest.fn(async () => ({
        text: 'A'.repeat(500) + ' полный текст статьи с подробностями о компании QazCloud',
      })),
    } as unknown as ParserService;

    global.fetch = jest.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      expect(body.input).toContain('полный текст статьи');
      return {
        ok: true,
        json: async () => structuredOutput({ sentiment: 'neutral', reason: 'r', summary: 's' }),
      };
    }) as unknown as typeof fetch;

    const service = new SentimentAnalysisService(makeConfig(), parserService);
    await service.classify('Заголовок', 'короткий тизер', 'https://example.com/a');

    expect(parserService.fetchArticleText).toHaveBeenCalledWith('https://example.com/a');
  });
});
