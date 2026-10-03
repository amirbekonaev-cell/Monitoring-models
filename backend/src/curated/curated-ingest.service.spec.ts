import { ConfigService } from '@nestjs/config';
import { Repository } from 'typeorm';
import { CuratedIngestService, curatedMentionHash, humanizeError, withTrailingSlashVariant } from './curated-ingest.service';
import { CuratedLink, CuratedLinkStatus } from './curated-link.entity';
import { CuratedOpenAiReaderService } from './curated-openai-reader.service';
import { ParserService } from '../collectors/parser/parser.service';
import { KeywordsService, ActiveKeywordSet } from '../keywords/keywords.service';
import { MentionsService } from '../mentions/mentions.service';
import { SourcesService } from '../sources/sources.service';
import { MentionSourceType, Sentiment } from '../mentions/mention.entity';
import { HostQueue } from './host-queue.util';

// example.com throughout — the real pool file is never committed and its links never appear in
// tests. See README "Приватность".
const PAGE_URL = 'https://example.com/2026-04-20/article-slug';

const DEFAULTS: Record<string, unknown> = {
  'curated.readMode': 'auto',
  'curated.minPageTextChars': 400,
  'curated.maxAttempts': 3,
  'curated.linkTimeoutMs': 25000,
  'curated.concurrency': 4,
  'curated.hostDelayMs': 0,
};

function makeConfig(overrides: Record<string, unknown> = {}): ConfigService {
  const values = { ...DEFAULTS, ...overrides };
  return { get: jest.fn((key: string) => values[key]) } as unknown as ConfigService;
}

function makeLink(overrides: Partial<CuratedLink> = {}): CuratedLink {
  return {
    id: 'link-1',
    url: PAGE_URL,
    urlHash: 'a'.repeat(64),
    host: 'example.com',
    groupLabel: 'kursiv',
    status: CuratedLinkStatus.PENDING,
    attempts: 0,
    lastError: null,
    dateSource: null,
    mentionId: null,
    lastAttemptAt: null,
    processedAt: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  } as CuratedLink;
}

/** A long body so the "page looks real" threshold is comfortably cleared. */
function articleBody(mentionsCompany = true): string {
  const filler = 'Текст статьи про облачные технологии в Казахстане. '.repeat(30);
  return mentionsCompany ? `${filler} Компания QazCloud запустила дата-центр. ${filler}` : filler;
}

interface Harness {
  service: CuratedIngestService;
  linksRepo: { update: jest.Mock; manager: { query: jest.Mock } };
  parser: { fetchPageDetailed: jest.Mock };
  reader: { readPage: jest.Mock; isConfigured: jest.Mock };
  mentions: {
    createIfNewAndClassify: jest.Mock;
    updateCuratedContent: jest.Mock;
    classifyExisting: jest.Mock;
    findById: jest.Mock;
  };
  context: Parameters<CuratedIngestService['processLink']>[1];
}

function makeHarness(
  options: {
    config?: Record<string, unknown>;
    keywordMatched?: boolean;
    parser?: jest.Mock;
    reader?: jest.Mock;
    /** Start with a mention already attached to this link — the `--force` re-run path. */
    existingMention?: boolean;
    existingSentiment?: Sentiment;
  } = {},
): Harness {
  // Mirrors reality: before the insert this link has produced no mention, after it there is one.
  // (Returning a mention up front would send processLink down its --force update path instead.)
  let mentionExists = options.existingMention ?? false;
  const linksRepo = {
    update: jest.fn().mockResolvedValue(undefined),
    manager: {
      query: jest.fn().mockImplementation(async () => (mentionExists ? [{ id: 'mention-1' }] : [])),
    },
  };

  const parser = {
    fetchPageDetailed:
      options.parser ??
      jest.fn().mockResolvedValue({ title: 'Заголовок', text: articleBody(), publishedAt: null }),
  };

  const reader = {
    readPage:
      options.reader ??
      jest.fn().mockResolvedValue({
        title: 'Заголовок от модели',
        publishedAtIso: '2025-11-14',
        mentionsCompany: true,
        fragments: ['Компания QazCloud открыла дата-центр в Астане.'],
        webSearchCalls: 1,
      }),
    isConfigured: jest.fn().mockReturnValue(true),
  };

  const mentions = {
    createIfNewAndClassify: jest.fn().mockImplementation(async () => {
      mentionExists = true;
      return { result: 'inserted', sentiment: Sentiment.POSITIVE };
    }),
    updateCuratedContent: jest.fn().mockResolvedValue(undefined),
    classifyExisting: jest.fn().mockResolvedValue(undefined),
    findById: jest.fn().mockResolvedValue({ id: 'mention-1', sentiment: options.existingSentiment ?? Sentiment.NEUTRAL }),
  };

  const service = new CuratedIngestService(
    linksRepo as unknown as Repository<CuratedLink>,
    makeConfig(options.config),
    parser as unknown as ParserService,
    reader as unknown as CuratedOpenAiReaderService,
    {} as KeywordsService,
    mentions as unknown as MentionsService,
    {} as SourcesService,
  );

  const matched = options.keywordMatched ?? true;
  const keywordSet = {
    match: jest.fn().mockResolvedValue({ matched, matchedKeywords: matched ? ['QazCloud'] : [] }),
  } as unknown as ActiveKeywordSet;

  return {
    service,
    linksRepo,
    parser,
    reader,
    mentions,
    context: {
      keywordSet,
      companyForms: ['QazCloud', 'Казклауд'],
      sourceId: 'source-curated',
      hostQueue: new HostQueue(0),
    } as Parameters<CuratedIngestService['processLink']>[1],
  };
}

describe('CuratedIngestService.processLink', () => {
  it('reads with the free parser and never calls OpenAI when the page comes back whole', async () => {
    const h = makeHarness();

    const outcome = await h.service.processLink(makeLink(), h.context);

    expect(outcome.status).toBe(CuratedLinkStatus.PROCESSED);
    expect(outcome.readVia).toBe('parser');
    expect(outcome.webSearchCalls).toBe(0);
    expect(h.reader.readPage).not.toHaveBeenCalled();
  });

  it('inserts the mention hidden, undeduplicated, and labelled with the group — not the domain', async () => {
    const h = makeHarness();

    await h.service.processLink(makeLink({ groupLabel: 'bluescreen' }), h.context);

    const input = h.mentions.createIfNewAndClassify.mock.calls[0][0];
    expect(input.urlHidden).toBe(true);
    expect(input.skipDedup).toBe(true);
    expect(input.curatedLinkId).toBe('link-1');
    expect(input.sourceType).toBe(MentionSourceType.NEWS);
    expect(input.sourceId).toBe('source-curated');
    expect(input.sourceLabel).toBe('bluescreen');
    expect(input.sourceLabel).not.toContain('example.com');
    expect(input.hash).toBe(curatedMentionHash('a'.repeat(64)));
  });

  it('falls back to OpenAI when the parser returns a page that is too short to be an article', async () => {
    // What an anti-bot interstitial or a JS-rendered shell looks like from the HTTP parser.
    const h = makeHarness({
      parser: jest.fn().mockResolvedValue({ title: 'Just a moment...', text: 'Проверка браузера', publishedAt: null }),
    });

    const outcome = await h.service.processLink(makeLink(), h.context);

    expect(h.reader.readPage).toHaveBeenCalledTimes(1);
    expect(outcome.readVia).toBe('openai');
    expect(outcome.webSearchCalls).toBe(1);
    expect(outcome.status).toBe(CuratedLinkStatus.PROCESSED);
  });

  it('falls back to OpenAI when the page 404s', async () => {
    const h = makeHarness({ parser: jest.fn().mockRejectedValue(new Error('HTTP 404')) });

    const outcome = await h.service.processLink(makeLink(), h.context);

    expect(outcome.readVia).toBe('openai');
    expect(outcome.status).toBe(CuratedLinkStatus.PROCESSED);
  });

  it('CURATED_READ_MODE=openai skips the HTTP parser entirely', async () => {
    const h = makeHarness({ config: { 'curated.readMode': 'openai' } });

    const outcome = await h.service.processLink(makeLink(), h.context);

    expect(h.parser.fetchPageDetailed).not.toHaveBeenCalled();
    expect(outcome.readVia).toBe('openai');
  });

  it('takes the date from the URL when the page metadata has none', async () => {
    const h = makeHarness();

    const outcome = await h.service.processLink(makeLink(), h.context);

    expect(outcome.dateSource).toBe('url');
    expect(h.mentions.createIfNewAndClassify.mock.calls[0][0].publishedAt).toEqual(new Date(Date.UTC(2026, 3, 20)));
  });

  it('prefers page metadata over the URL date', async () => {
    const pageDate = new Date('2026-04-19T08:00:00Z');
    const h = makeHarness({
      parser: jest.fn().mockResolvedValue({ title: 'Заголовок', text: articleBody(), publishedAt: pageDate }),
    });

    const outcome = await h.service.processLink(makeLink(), h.context);

    expect(outcome.dateSource).toBe('page');
    expect(h.mentions.createIfNewAndClassify.mock.calls[0][0].publishedAt).toEqual(pageDate);
  });

  it('uses the model date when neither the page nor the URL carries one', async () => {
    const h = makeHarness({ config: { 'curated.readMode': 'openai' } });

    const outcome = await h.service.processLink(makeLink({ url: 'https://example.com/news/view/slug' }), h.context);

    expect(outcome.dateSource).toBe('model');
  });

  it('leaves published_at null rather than substituting today when no source has a date', async () => {
    const h = makeHarness({
      config: { 'curated.readMode': 'openai' },
      reader: jest.fn().mockResolvedValue({
        title: 'Заголовок',
        publishedAtIso: null,
        mentionsCompany: true,
        fragments: ['Компания QazCloud открыла дата-центр.'],
        webSearchCalls: 1,
      }),
    });

    const outcome = await h.service.processLink(makeLink({ url: 'https://example.com/news/view/slug' }), h.context);

    expect(outcome.dateSource).toBeNull();
    expect(h.mentions.createIfNewAndClassify.mock.calls[0][0].publishedAt).toBeNull();
  });

  it('marks a page without the company as not_relevant and creates no mention', async () => {
    const h = makeHarness({ keywordMatched: false });

    const outcome = await h.service.processLink(makeLink(), h.context);

    expect(outcome.status).toBe(CuratedLinkStatus.NOT_RELEVANT);
    expect(outcome.error).toContain('ключевых слов');
    expect(h.mentions.createIfNewAndClassify).not.toHaveBeenCalled();
    expect(h.linksRepo.update).toHaveBeenCalledWith(
      'link-1',
      expect.objectContaining({ status: CuratedLinkStatus.NOT_RELEVANT }),
    );
  });

  it("does not trust the model's mention claim when its own fragments contain no keyword", async () => {
    const h = makeHarness({
      config: { 'curated.readMode': 'openai' },
      keywordMatched: false,
      reader: jest.fn().mockResolvedValue({
        title: 'Заголовок',
        publishedAtIso: null,
        mentionsCompany: true,
        fragments: ['Фрагмент без названия компании.'],
        webSearchCalls: 1,
      }),
    });

    const outcome = await h.service.processLink(makeLink(), h.context);

    expect(outcome.status).toBe(CuratedLinkStatus.NOT_RELEVANT);
    expect(h.mentions.createIfNewAndClassify).not.toHaveBeenCalled();
  });

  it('keeps a link pending with attempts + 1 on a failure that has attempts left', async () => {
    const h = makeHarness({
      parser: jest.fn().mockRejectedValue(new Error('HTTP 500')),
      reader: jest.fn().mockRejectedValue(new Error('OpenAI Responses API HTTP 500: server error')),
    });

    const outcome = await h.service.processLink(makeLink({ attempts: 0 }), h.context);

    expect(outcome.status).toBe(CuratedLinkStatus.PENDING);
    expect(h.linksRepo.update).toHaveBeenCalledWith(
      'link-1',
      expect.objectContaining({ status: CuratedLinkStatus.PENDING, attempts: 1 }),
    );
  });

  it('marks a link failed once CURATED_MAX_ATTEMPTS is reached', async () => {
    const h = makeHarness({
      parser: jest.fn().mockRejectedValue(new Error('HTTP 500')),
      reader: jest.fn().mockRejectedValue(new Error('OpenAI Responses API HTTP 500: server error')),
    });

    const outcome = await h.service.processLink(makeLink({ attempts: 2 }), h.context);

    expect(outcome.status).toBe(CuratedLinkStatus.FAILED);
    expect(h.linksRepo.update).toHaveBeenCalledWith(
      'link-1',
      expect.objectContaining({ status: CuratedLinkStatus.FAILED, attempts: 3 }),
    );
  });

  it('records a timeout as a retryable attempt rather than losing the link', async () => {
    const h = makeHarness({
      config: { 'curated.linkTimeoutMs': 20 },
      parser: jest.fn(
        (_url: string, signal?: AbortSignal) =>
          new Promise((_resolve, reject) => {
            signal?.addEventListener('abort', () => reject(new Error('The operation was aborted')));
          }),
      ),
    });

    const outcome = await h.service.processLink(makeLink(), h.context);

    expect(outcome.status).toBe(CuratedLinkStatus.PENDING);
    expect(outcome.error).toContain('таймаут');
    expect(h.mentions.createIfNewAndClassify).not.toHaveBeenCalled();
  });

  it('reports a missing OPENAI_API_KEY as a readable error instead of crashing the run', async () => {
    const h = makeHarness({
      parser: jest.fn().mockRejectedValue(new Error('HTTP 403')),
      reader: jest.fn().mockRejectedValue(new Error('OPENAI_API_KEY не задан — страницу нельзя прочитать')),
    });

    const outcome = await h.service.processLink(makeLink(), h.context);

    expect(outcome.error).toContain('OPENAI_API_KEY');
    expect(outcome.status).toBe(CuratedLinkStatus.PENDING);
  });

  it('never writes the link URL into last_error', async () => {
    const h = makeHarness({
      parser: jest.fn().mockRejectedValue(new Error(`Не удалось открыть ${PAGE_URL}: ECONNRESET`)),
      reader: jest.fn().mockRejectedValue(new Error(`Не удалось открыть ${PAGE_URL}: ECONNRESET`)),
    });

    const outcome = await h.service.processLink(makeLink(), h.context);

    expect(outcome.error).not.toContain(PAGE_URL);
    expect(outcome.error).not.toContain('/2026-04-20/article-slug');
    const written = h.linksRepo.update.mock.calls[0][1] as { lastError: string };
    expect(written.lastError).not.toContain(PAGE_URL);
  });

  it('повторная обработка обновляет уже созданное упоминание, а не вставляет второе', async () => {
    // Без этого --force молча ничего не менял бы: partial UNIQUE по curated_link_id гасит
    // вторую вставку, и исправленная дата не доехала бы до существующей строки.
    const h = makeHarness({ existingMention: true });

    const outcome = await h.service.processLink(makeLink({ mentionId: 'mention-1' }), h.context);

    expect(h.mentions.createIfNewAndClassify).not.toHaveBeenCalled();
    expect(h.mentions.updateCuratedContent).toHaveBeenCalledWith(
      'mention-1',
      expect.objectContaining({ publishedAt: new Date(Date.UTC(2026, 3, 20)) }),
    );
    expect(outcome.status).toBe(CuratedLinkStatus.PROCESSED);
  });

  it('повторная обработка не переклассифицирует уже определённую тональность (и не платит второй раз)', async () => {
    const h = makeHarness({ existingMention: true, existingSentiment: Sentiment.NEGATIVE });

    const outcome = await h.service.processLink(makeLink({ mentionId: 'mention-1' }), h.context);

    expect(h.mentions.classifyExisting).not.toHaveBeenCalled();
    expect(outcome.sentimentCalls).toBe(0);
    expect(outcome.sentiment).toBe(Sentiment.NEGATIVE);
  });

  it('повторная обработка доклассифицирует упоминание, оставшееся без тональности', async () => {
    // Так строки, созданные без OPENAI_API_KEY, получают тональность при следующем прогоне.
    const h = makeHarness({ existingMention: true, existingSentiment: Sentiment.UNDEFINED });

    const outcome = await h.service.processLink(makeLink({ mentionId: 'mention-1' }), h.context);

    expect(h.mentions.classifyExisting).toHaveBeenCalledWith('mention-1');
    expect(outcome.sentimentCalls).toBe(1);
  });

  it('passes the extracted context — not the whole article — as the mention text', async () => {
    const h = makeHarness();

    await h.service.processLink(makeLink(), h.context);

    const { text } = h.mentions.createIfNewAndClassify.mock.calls[0][0];
    expect(text).toContain('QazCloud запустила дата-центр');
    expect(text.length).toBeLessThanOrEqual(4001);
  });
});

/**
 * CURATED_MIN_ARTICLE_DATE — the optional "too old to be worth a mention" cutoff. Every case below
 * uses a URL with no date in it (`/article-slug`) and puts the date on the page metadata instead,
 * so the test controls the article's date exactly rather than inheriting PAGE_URL's 2026-04-20.
 */
describe('CuratedIngestService.processLink — отсечка по дате статьи', () => {
  const DATELESS_URL = 'https://example.com/article-slug';
  const THRESHOLD = new Date(Date.UTC(2023, 0, 1));

  function harnessWithPageDate(pageDate: Date | null, config: Record<string, unknown> = {}) {
    return makeHarness({
      config,
      parser: jest.fn().mockResolvedValue({ title: 'Заголовок', text: articleBody(), publishedAt: pageDate }),
    });
  }

  it('marks an article older than the threshold not_relevant and creates no mention', async () => {
    const h = harnessWithPageDate(new Date('2019-05-04T08:00:00Z'), { 'curated.minArticleDate': THRESHOLD });

    const outcome = await h.service.processLink(makeLink({ url: DATELESS_URL }), h.context);

    expect(outcome.status).toBe(CuratedLinkStatus.NOT_RELEVANT);
    expect(outcome.error).toContain('статья старше порога CURATED_MIN_ARTICLE_DATE');
    expect(h.mentions.createIfNewAndClassify).not.toHaveBeenCalled();
    expect(h.linksRepo.update).toHaveBeenCalledWith(
      'link-1',
      expect.objectContaining({ status: CuratedLinkStatus.NOT_RELEVANT, lastError: outcome.error }),
    );
  });

  // The comparison is `<`, not `<=`: "с 2023-01-01" has to include the first of January itself.
  it('keeps an article published exactly on the threshold day', async () => {
    const h = harnessWithPageDate(new Date('2023-01-01T00:00:00Z'), { 'curated.minArticleDate': THRESHOLD });

    const outcome = await h.service.processLink(makeLink({ url: DATELESS_URL }), h.context);

    expect(outcome.status).toBe(CuratedLinkStatus.PROCESSED);
    expect(h.mentions.createIfNewAndClassify).toHaveBeenCalledTimes(1);
  });

  it('keeps an article newer than the threshold', async () => {
    const h = harnessWithPageDate(new Date('2026-02-02T00:00:00Z'), { 'curated.minArticleDate': THRESHOLD });

    const outcome = await h.service.processLink(makeLink({ url: DATELESS_URL }), h.context);

    expect(outcome.status).toBe(CuratedLinkStatus.PROCESSED);
  });

  // An undated article is not "old", it is unknown — and it is already excluded from every period
  // window and counted separately ("без даты"). The threshold must not quietly delete that case.
  it('does not touch an article with no date at all', async () => {
    const h = harnessWithPageDate(null, { 'curated.minArticleDate': THRESHOLD });

    const outcome = await h.service.processLink(makeLink({ url: DATELESS_URL }), h.context);

    expect(outcome.status).toBe(CuratedLinkStatus.PROCESSED);
    expect(outcome.dateSource).toBeNull();
    expect(h.mentions.createIfNewAndClassify.mock.calls[0][0].publishedAt).toBeNull();
  });

  it('applies no cutoff when the variable is unset — a 2018 article still becomes a mention', async () => {
    const h = harnessWithPageDate(new Date('2018-06-01T00:00:00Z'));

    const outcome = await h.service.processLink(makeLink({ url: DATELESS_URL }), h.context);

    expect(outcome.status).toBe(CuratedLinkStatus.PROCESSED);
    expect(h.mentions.createIfNewAndClassify).toHaveBeenCalledTimes(1);
  });

  // parseCuratedMinArticleDate() already rejected the malformed value with a warn, leaving null in
  // config; the service must behave exactly as if nothing was configured, not crash on it.
  it('ignores an invalid configured value instead of failing the link', async () => {
    const h = harnessWithPageDate(new Date('2018-06-01T00:00:00Z'), { 'curated.minArticleDate': null });

    const outcome = await h.service.processLink(makeLink({ url: DATELESS_URL }), h.context);

    expect(outcome.status).toBe(CuratedLinkStatus.PROCESSED);
    expect(h.mentions.createIfNewAndClassify).toHaveBeenCalledTimes(1);
  });
});

describe('CuratedIngestService.processLink — CURATED_SUMMARY_WORDS', () => {
  it('asks for no particular summary length when the variable is unset', async () => {
    const h = makeHarness();

    await h.service.processLink(makeLink(), h.context);

    expect(h.mentions.createIfNewAndClassify.mock.calls[0][0].sentimentOptions).toBeUndefined();
  });

  it('passes the configured word count to the (single, shared) classifier for pool links', async () => {
    const h = makeHarness({ config: { 'curated.summaryWords': 50 } });

    await h.service.processLink(makeLink(), h.context);

    expect(h.mentions.createIfNewAndClassify.mock.calls[0][0].sentimentOptions).toEqual({ summaryWords: 50 });
  });

  it('passes it on the --force re-classification path too', async () => {
    const h = makeHarness({
      config: { 'curated.summaryWords': 50 },
      existingMention: true,
      existingSentiment: Sentiment.UNDEFINED,
    });

    await h.service.processLink(makeLink({ mentionId: 'mention-1' }), h.context);

    expect(h.mentions.classifyExisting).toHaveBeenCalledWith('mention-1', { summaryWords: 50 });
  });

  it.each([0, -5, NaN, undefined])('treats %p as "not configured"', async (value) => {
    const h = makeHarness({ config: { 'curated.summaryWords': value } });

    await h.service.processLink(makeLink(), h.context);

    expect(h.mentions.createIfNewAndClassify.mock.calls[0][0].sentimentOptions).toBeUndefined();
  });
});

describe('humanizeError', () => {
  it('replaces any URL with a host-only placeholder', () => {
    const result = humanizeError(new Error('fetch failed for https://example.com/secret/path'), 'example.com');
    expect(result).not.toContain('/secret/path');
    expect(result).toContain('example.com');
  });

  it('turns common HTTP failures into readable Russian', () => {
    expect(humanizeError(new Error('HTTP 404'), 'example.com')).toContain('HTTP 404');
    expect(humanizeError(new Error('HTTP 403'), 'example.com')).toContain('доступ к странице закрыт');
  });

  it('handles a non-Error throw', () => {
    expect(humanizeError('просто строка', 'example.com')).toBe('просто строка');
  });
});

describe('curatedMentionHash', () => {
  it('is a 64-char digest, stable per link and distinct between links', () => {
    const a = curatedMentionHash('a'.repeat(64));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).toBe(curatedMentionHash('a'.repeat(64)));
    expect(a).not.toBe(curatedMentionHash('b'.repeat(64)));
  });
});

describe('withTrailingSlashVariant', () => {
  it('offers the slashed spelling as a second attempt', () => {
    // sk.kz answers 404 for the path and 200 for the path + "/" — the normalizer strips it, so
    // the reader has to try both before paying for an OpenAI read.
    expect(withTrailingSlashVariant('https://example.com/news/56084')).toEqual([
      'https://example.com/news/56084',
      'https://example.com/news/56084/',
    ]);
  });

  it('offers nothing extra when the URL already ends in a slash', () => {
    expect(withTrailingSlashVariant('https://example.com/news/56084/')).toEqual(['https://example.com/news/56084/']);
  });

  it('offers nothing extra for a bare root', () => {
    expect(withTrailingSlashVariant('https://example.com/')).toEqual(['https://example.com/']);
  });

  it('keeps the query string on the variant', () => {
    expect(withTrailingSlashVariant('https://example.com/a?id=1')).toEqual([
      'https://example.com/a?id=1',
      'https://example.com/a/?id=1',
    ]);
  });

  it('returns the input unchanged when it is not a URL', () => {
    expect(withTrailingSlashVariant('not a url')).toEqual(['not a url']);
  });
});
