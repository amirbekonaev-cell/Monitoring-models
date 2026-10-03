import { ConfigService } from '@nestjs/config';
import { SentimentAnalysisService, buildSentimentPrompt } from './sentiment-analysis.service';
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

describe('SentimentAnalysisService — предупреждение о ключе на старте', () => {
  function makeService(apiKey: string) {
    const config = { get: jest.fn((k: string) => (k === 'sentimentAnalysis.apiKey' ? apiKey : undefined)) };
    return new SentimentAnalysisService(config as any, {} as any);
  }

  // A misspelled variable name in .env (OPEN_API_KEY instead of OPENAI_API_KEY — a real one on
  // this project) is indistinguishable from no key at all, and without a startup signal it only
  // shows up as the whole dataset sitting at "не определена".
  it('warns once at startup when no key is configured', () => {
    const service = makeService('');
    const warn = jest.spyOn((service as any).logger, 'warn').mockImplementation(() => undefined);

    service.onModuleInit();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('OPENAI_API_KEY');
  });

  it('stays quiet when a key is configured', () => {
    const service = makeService('sk-test');
    const warn = jest.spyOn((service as any).logger, 'warn').mockImplementation(() => undefined);

    service.onModuleInit();

    expect(warn).not.toHaveBeenCalled();
  });
});

/**
 * CURATED_SUMMARY_WORDS — a per-call summary length, used only by the closed pool. The prompt is
 * shared by all six ingestion channels, so the contract tested here is twofold: with no options
 * the instructions string is the SAME STRING as before (compared literally, not "looks similar"),
 * and with options only the length guidance changes.
 */
describe('buildSentimentPrompt', () => {
  const baseline = buildSentimentPrompt();

  it.each([undefined, {}, { summaryWords: 0 }, { summaryWords: -10 }, { summaryWords: NaN }])(
    'returns the shared prompt unchanged for %p',
    (options) => {
      expect(buildSentimentPrompt(options as any)).toBe(baseline);
    },
  );

  it('still asks for the default 1-2 sentences / ~250 characters when nothing is passed', () => {
    expect(baseline).toContain('в 1-2 предложения (не более ~250 символов)');
    expect(baseline).not.toContain('около');
  });

  it('asks for approximately N words when a word count is passed', () => {
    const prompt = buildSentimentPrompt({ summaryWords: 50 });

    expect(prompt).toContain('около 50 слов');
    expect(prompt).not.toContain('в 1-2 предложения (не более ~250 символов)');
    // Everything else about the prompt — the sentiment enum, the reason field, the "read the whole
    // article" instruction — must be identical; only the length sentence may differ.
    expect(prompt.replace('объёмом около 50 слов', 'в 1-2 предложения (не более ~250 символов)')).toBe(baseline);
  });

  it('rounds a fractional count rather than printing it', () => {
    expect(buildSentimentPrompt({ summaryWords: 49.6 })).toContain('около 50 слов');
  });
});

describe('SentimentAnalysisService.classify — параметр длины пересказа', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  function captureInstructions(): { body: () => any } {
    let captured: any;
    global.fetch = jest.fn(async (_url: string, init: RequestInit) => {
      captured = JSON.parse(init.body as string);
      return {
        ok: true,
        json: async () => structuredOutput({ sentiment: 'neutral', reason: 'нейтрально', summary: 'пересказ' }),
      };
    }) as unknown as typeof fetch;
    return { body: () => captured };
  }

  it('sends the unchanged shared prompt when no options are given (other channels)', async () => {
    const captured = captureInstructions();
    const service = new SentimentAnalysisService(makeConfig(), makeParserService());

    await service.classify('Заголовок', 'a'.repeat(500));

    expect(captured.body().instructions).toBe(buildSentimentPrompt());
  });

  it('sends the word count in the instructions when the pool asks for it', async () => {
    const captured = captureInstructions();
    const service = new SentimentAnalysisService(makeConfig(), makeParserService());

    await service.classify('Заголовок', 'a'.repeat(500), null, { summaryWords: 50 });

    expect(captured.body().instructions).toContain('около 50 слов');
  });

  it('does not change the response schema — still the same three required fields', async () => {
    const captured = captureInstructions();
    const service = new SentimentAnalysisService(makeConfig(), makeParserService());

    await service.classify('Заголовок', 'a'.repeat(500), null, { summaryWords: 50 });

    expect(captured.body().text.format.schema.required).toEqual(['sentiment', 'reason', 'summary']);
    expect(captured.body().text.format.name).toBe('sentiment_classification');
  });
});
