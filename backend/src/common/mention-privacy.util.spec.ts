import { redactHiddenMentions, shouldExposeCuratedUrls } from './mention-privacy.util';

const HIDDEN_URL = 'https://example.com/pool/secret-article-slug';

function hiddenMention(overrides: Record<string, unknown> = {}) {
  return {
    id: 'm-hidden',
    title: 'Заголовок из пула',
    url: HIDDEN_URL,
    reprints: [{ url: 'https://example.com/pool/reprint', sourceId: null, foundAt: '2026-01-01T00:00:00Z' }],
    urlHidden: true,
    curatedLinkId: 'link-1',
    ...overrides,
  };
}

function publicMention(overrides: Record<string, unknown> = {}) {
  return {
    id: 'm-public',
    title: 'Обычная новость',
    url: 'https://example.com/public/article',
    reprints: [{ url: 'https://example.com/public/reprint', sourceId: null, foundAt: '2026-01-01T00:00:00Z' }],
    urlHidden: false,
    ...overrides,
  };
}

describe('redactHiddenMentions', () => {
  it('nulls the url and empties reprints on a hidden mention', () => {
    const result = redactHiddenMentions(hiddenMention()) as Record<string, unknown>;

    expect(result.url).toBeNull();
    expect(result.reprints).toEqual([]);
    expect(JSON.stringify(result)).not.toContain(HIDDEN_URL);
  });

  it('leaves everything else on a hidden mention intact', () => {
    const result = redactHiddenMentions(hiddenMention()) as Record<string, unknown>;

    expect(result.id).toBe('m-hidden');
    expect(result.title).toBe('Заголовок из пула');
  });

  it('leaves a public mention completely untouched, same object identity', () => {
    const input = publicMention();
    expect(redactHiddenMentions(input)).toBe(input);
  });

  it('redacts hidden mentions nested inside a list response', () => {
    const payload = { items: [publicMention(), hiddenMention()], total: 2, limit: 50, offset: 0 };

    const result = redactHiddenMentions(payload);

    expect(JSON.stringify(result)).not.toContain(HIDDEN_URL);
    expect(result.items[0].url).toBe('https://example.com/public/article');
    expect(result.items[1].url).toBeNull();
    expect(result.total).toBe(2);
  });

  it('recognises the snake_case column name too (a raw query result)', () => {
    const raw = { id: 'm', url: HIDDEN_URL, url_hidden: true };
    expect(JSON.stringify(redactHiddenMentions(raw))).not.toContain(HIDDEN_URL);
  });

  it('scrubs a URL out of the text of a hidden mention, not just the url field', () => {
    // Регрессия, найденная curated:leak-check на живом стенде: статья печатает собственный
    // адрес в теле, и он уезжал в ответе GET /mentions при корректно скрытом url.
    const mention = hiddenMention({ text: `Текст статьи. Источник: ${HIDDEN_URL} конец.` });

    const result = redactHiddenMentions(mention) as Record<string, unknown>;

    expect(JSON.stringify(result)).not.toContain(HIDDEN_URL);
    expect(JSON.stringify(result)).not.toContain('/pool/secret-article-slug');
    expect(result.text).toContain('Текст статьи.');
  });

  it('scrubs a URL out of summary and title of a hidden mention too', () => {
    const mention = hiddenMention({ summary: `Кратко: ${HIDDEN_URL}`, title: `Заголовок ${HIDDEN_URL}` });
    expect(JSON.stringify(redactHiddenMentions(mention))).not.toContain('/pool/secret-article-slug');
  });

  it('leaves the text of a PUBLIC mention untouched, links and all', () => {
    const mention = publicMention({ text: 'Читайте на https://example.com/public/article' });
    const result = redactHiddenMentions(mention) as Record<string, unknown>;
    expect(result.text).toBe('Читайте на https://example.com/public/article');
  });

  it('does not mutate the input', () => {
    const input = hiddenMention();
    redactHiddenMentions(input);
    expect(input.url).toBe(HIDDEN_URL);
  });

  it('passes through primitives, null and Dates unchanged', () => {
    const date = new Date('2026-01-01T00:00:00Z');
    expect(redactHiddenMentions(null)).toBeNull();
    expect(redactHiddenMentions(42)).toBe(42);
    expect(redactHiddenMentions('строка')).toBe('строка');
    expect(redactHiddenMentions(date)).toBe(date);
  });

  it('stops at the depth limit instead of recursing forever on a cyclic payload', () => {
    const cyclic: Record<string, unknown> = { level: 0 };
    cyclic.self = cyclic;
    expect(() => redactHiddenMentions(cyclic)).not.toThrow();
  });
});

describe('shouldExposeCuratedUrls', () => {
  it('is false by default and for anything other than the exact string "true"', () => {
    expect(shouldExposeCuratedUrls({} as NodeJS.ProcessEnv)).toBe(false);
    expect(shouldExposeCuratedUrls({ CURATED_LINKS_EXPOSE_URLS: 'false' } as NodeJS.ProcessEnv)).toBe(false);
    expect(shouldExposeCuratedUrls({ CURATED_LINKS_EXPOSE_URLS: '1' } as NodeJS.ProcessEnv)).toBe(false);
    expect(shouldExposeCuratedUrls({ CURATED_LINKS_EXPOSE_URLS: 'TRUE' } as NodeJS.ProcessEnv)).toBe(false);
  });

  it('is true only for CURATED_LINKS_EXPOSE_URLS=true', () => {
    expect(shouldExposeCuratedUrls({ CURATED_LINKS_EXPOSE_URLS: 'true' } as NodeJS.ProcessEnv)).toBe(true);
  });
});
