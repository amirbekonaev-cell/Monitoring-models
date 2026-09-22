/**
 * The privacy requirement stated end-to-end: for a `url_hidden` mention, NO response body of
 * the public API may contain its URL or even the path of that URL.
 *
 * Deliberately exercised through real controllers over real HTTP (supertest) rather than by
 * calling the mapper directly: the claim being defended is about what a stranger with the
 * deployment URL can read back, and only a request through the actual Nest pipeline — routing,
 * the globally registered interceptor, JSON serialization — proves that. MentionsService is
 * stubbed so the test needs no database; everything above it is the real thing.
 */
import { INestApplication } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { agent as request } from 'supertest';
import { MentionPrivacyInterceptor } from './mention-privacy.interceptor';
import { MentionsController } from '../mentions/mentions.controller';
import { MentionsService } from '../mentions/mentions.service';
import { Sentiment } from '../mentions/mention.entity';

const HIDDEN_URL = 'https://example.com/pool/2026-04-20/hidden-article-slug';
const HIDDEN_PATH = '/pool/2026-04-20/hidden-article-slug';
const PUBLIC_URL = 'https://example.com/public/ordinary-article';

const hiddenMention = {
  id: 'm-hidden',
  title: 'Материал из закрытого пула',
  text: 'Фрагмент вокруг упоминания компании.',
  url: HIDDEN_URL,
  reprints: [{ url: `${HIDDEN_URL}-reprint`, sourceId: null, foundAt: '2026-04-20T00:00:00.000Z' }],
  publishedAt: '2026-04-20T00:00:00.000Z',
  sentiment: Sentiment.POSITIVE,
  sourceLabel: 'kursiv',
  urlHidden: true,
  curatedLinkId: 'link-1',
};

const publicMention = {
  id: 'm-public',
  title: 'Обычная новость',
  text: 'Текст.',
  url: PUBLIC_URL,
  reprints: [],
  publishedAt: '2026-04-20T00:00:00.000Z',
  sentiment: Sentiment.NEUTRAL,
  sourceLabel: null,
  urlHidden: false,
  curatedLinkId: null,
};

function makeMentionsServiceStub(): Partial<MentionsService> {
  return {
    findRecent: jest.fn().mockResolvedValue({ items: [publicMention, hiddenMention], total: 2 }),
    getStats: jest.fn().mockResolvedValue({
      total: 2,
      previousTotal: 0,
      changePercent: null,
      byDay: [{ date: '2026-04-20', count: 2 }],
      bySentiment: { positive: 1, negative: 0, neutral: 1, undefined: 0 },
      // A source name is not a mention, but it is a place a URL could realistically end up —
      // worth having in the probed payload.
      topSources: [{ sourceId: 's-1', name: 'Подборка материалов', count: 2 }],
    }),
    updateSentimentManually: jest.fn().mockResolvedValue({ ...hiddenMention, sentiment: Sentiment.NEGATIVE }),
  };
}

async function bootApp(): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    controllers: [MentionsController],
    providers: [
      { provide: MentionsService, useValue: makeMentionsServiceStub() },
      { provide: APP_INTERCEPTOR, useClass: MentionPrivacyInterceptor },
    ],
  }).compile();

  const app = moduleRef.createNestApplication();
  await app.init();
  return app;
}

describe('Приватность ссылок пула на уровне HTTP', () => {
  let app: INestApplication;
  const originalExpose = process.env.CURATED_LINKS_EXPOSE_URLS;

  beforeEach(async () => {
    delete process.env.CURATED_LINKS_EXPOSE_URLS;
    app = await bootApp();
  });

  afterEach(async () => {
    await app.close();
    if (originalExpose === undefined) {
      delete process.env.CURATED_LINKS_EXPOSE_URLS;
    } else {
      process.env.CURATED_LINKS_EXPOSE_URLS = originalExpose;
    }
  });

  it('GET /mentions: ни URL, ни его путь не попадают в тело ответа', async () => {
    const res = await request(app.getHttpServer()).get('/mentions?limit=200').expect(200);
    const body = JSON.stringify(res.body);

    expect(body).not.toContain(HIDDEN_URL);
    expect(body).not.toContain(HIDDEN_PATH);
    expect(res.body.items).toHaveLength(2);
  });

  it('GET /mentions: скрытое упоминание отдаётся с url = null и пустыми reprints', async () => {
    const res = await request(app.getHttpServer()).get('/mentions').expect(200);
    const hidden = res.body.items.find((m: { id: string }) => m.id === 'm-hidden');

    expect(hidden.url).toBeNull();
    expect(hidden.reprints).toEqual([]);
    // The item itself must still be usable — only the link is withheld.
    expect(hidden.title).toBe('Материал из закрытого пула');
    expect(hidden.sentiment).toBe(Sentiment.POSITIVE);
  });

  it('GET /mentions: обычное упоминание отдаётся со ссылкой как раньше (регрессия)', async () => {
    const res = await request(app.getHttpServer()).get('/mentions').expect(200);
    const ordinary = res.body.items.find((m: { id: string }) => m.id === 'm-public');

    expect(ordinary.url).toBe(PUBLIC_URL);
  });

  it('GET /mentions/stats: агрегация не содержит ни URL, ни его пути', async () => {
    const res = await request(app.getHttpServer()).get('/mentions/stats?period=30d').expect(200);
    const body = JSON.stringify(res.body);

    expect(body).not.toContain(HIDDEN_URL);
    expect(body).not.toContain(HIDDEN_PATH);
    expect(res.body.total).toBe(2);
  });

  it('PATCH /mentions/:id/sentiment: обновлённое скрытое упоминание возвращается без ссылки', async () => {
    const res = await request(app.getHttpServer())
      .patch('/mentions/m-hidden/sentiment')
      .send({ sentiment: Sentiment.NEGATIVE })
      .expect(200);

    expect(JSON.stringify(res.body)).not.toContain(HIDDEN_PATH);
    expect(res.body.url).toBeNull();
    expect(res.body.sentiment).toBe(Sentiment.NEGATIVE);
  });

  it('CURATED_LINKS_EXPOSE_URLS=true: ссылки отдаются как обычно (явный аварийный режим)', async () => {
    process.env.CURATED_LINKS_EXPOSE_URLS = 'true';

    const res = await request(app.getHttpServer()).get('/mentions').expect(200);
    const hidden = res.body.items.find((m: { id: string }) => m.id === 'm-hidden');

    expect(hidden.url).toBe(HIDDEN_URL);
    expect(hidden.reprints).toHaveLength(1);
  });
});
