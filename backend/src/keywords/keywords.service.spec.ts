import { DataSource } from 'typeorm';
import { ActiveKeywordSet } from './keywords.service';
import { Keyword, KeywordType } from './keyword.entity';

function makeKeyword(overrides: Partial<Keyword>): Keyword {
  return {
    id: 'kw-' + Math.random(),
    phrase: 'test',
    type: KeywordType.REQUIRED,
    isActive: true,
    language: 'ru',
    manualForms: [],
    createdAt: new Date(),
    ...overrides,
  } as Keyword;
}

function makeDataSourceMock(ftsMatches: Record<string, boolean>) {
  return {
    query: jest.fn(async (sql: string, params: unknown[]) => {
      const [haystack, phrases] = params as [string, string[]];
      return phrases.map((phrase, i) => ({ idx: i, matched: ftsMatches[phrase] ?? false }));
    }),
  } as unknown as DataSource;
}

describe('ActiveKeywordSet', () => {
  it('passes everything through when there are no active positive keywords', async () => {
    const dataSource = makeDataSourceMock({});
    const set = new ActiveKeywordSet([], dataSource);
    const result = await set.match('любой текст', 'без ключевых слов');
    expect(result.matched).toBe(true);
  });

  it('matches a russian required keyword via full-text search (word forms)', async () => {
    const dataSource = makeDataSourceMock({ казахтелеком: true });
    const kw = makeKeyword({ phrase: 'казахтелеком', type: KeywordType.REQUIRED, language: 'ru' });
    const set = new ActiveKeywordSet([kw], dataSource);
    const result = await set.match('Казахтелекома обвинили в сбое', 'текст новости');
    expect(result.matched).toBe(true);
    expect(result.matchedKeywords).toContain('казахтелеком');
  });

  it('rejects an item that does not match any required keyword', async () => {
    const dataSource = makeDataSourceMock({ казахтелеком: false });
    const kw = makeKeyword({ phrase: 'казахтелеком', type: KeywordType.REQUIRED, language: 'ru' });
    const set = new ActiveKeywordSet([kw], dataSource);
    const result = await set.match('никакого отношения', 'к теме нет');
    expect(result.matched).toBe(false);
  });

  it('excludes items matching an active minus keyword even if a required keyword matches', async () => {
    const dataSource = makeDataSourceMock({ казахтелеком: true, реклама: true });
    const required = makeKeyword({ phrase: 'казахтелеком', type: KeywordType.REQUIRED });
    const minus = makeKeyword({ phrase: 'реклама', type: KeywordType.MINUS });
    const set = new ActiveKeywordSet([required, minus], dataSource);
    const result = await set.match('Казахтелеком: реклама нового тарифа', 'текст');
    expect(result.matched).toBe(false);
  });

  it('uses manualForms for a kazakh keyword instead of postgres FTS', async () => {
    const dataSource = makeDataSourceMock({});
    const kw = makeKeyword({
      phrase: 'қазақтелеком',
      type: KeywordType.REQUIRED,
      language: 'kk',
      manualForms: ['қазақтелекомның', 'қазақтелекомды'],
    });
    const set = new ActiveKeywordSet([kw], dataSource);

    const result = await set.match('Қазақтелекомның жаңа тарифі', 'мәтін');
    expect(result.matched).toBe(true);
    // FTS query must never be called for manual-forms keywords
    expect((dataSource.query as jest.Mock).mock.calls.length).toBe(0);
  });

  it('matches an exact_phrase keyword only as a literal substring', async () => {
    const dataSource = makeDataSourceMock({});
    const kw = makeKeyword({ phrase: 'новый тариф', type: KeywordType.EXACT_PHRASE });
    const set = new ActiveKeywordSet([kw], dataSource);

    const matchResult = await set.match('Компания запустила новый тариф', 'подробности');
    expect(matchResult.matched).toBe(true);

    const noMatch = await set.match('тариф оказался новым', 'подробности');
    expect(noMatch.matched).toBe(false);
  });
});
