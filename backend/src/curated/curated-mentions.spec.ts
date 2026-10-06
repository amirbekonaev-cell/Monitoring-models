import {
  CURATED_MENTIONS,
  findCuratedById,
  findCuratedByUrl,
  formatCuratedMessage,
  getCuratedStats,
  normalizeUrl,
} from './curated-mentions';

describe('curated mentions', () => {
  it('содержит все 168 карточек', () => {
    expect(CURATED_MENTIONS).toHaveLength(168);
  });

  it('у каждой карточки заполнены обязательные поля', () => {
    for (const m of CURATED_MENTIONS) {
      expect(m.id).toMatch(/^\d+\.\d+$/);
      expect(m.url).toMatch(/^https?:\/\//);
      expect(m.title.length).toBeGreaterThan(0);
      expect(m.summary.length).toBeGreaterThan(0);
      expect(['positive', 'neutral', 'negative', 'undefined']).toContain(m.sentiment);
    }
  });

  it('id уникальны', () => {
    const ids = new Set(CURATED_MENTIONS.map((m) => m.id));
    expect(ids.size).toBe(CURATED_MENTIONS.length);
  });

  it('дата либо null, либо корректный ISO-день', () => {
    for (const m of CURATED_MENTIONS) {
      if (m.publishedAt === null) continue;
      expect(m.publishedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(Number.isNaN(Date.parse(m.publishedAt))).toBe(false);
    }
  });

  it('поиск по URL не зависит от схемы, www и хвостов', () => {
    const sample = CURATED_MENTIONS[0];
    expect(findCuratedByUrl(sample.url)?.id).toBe(sample.id);
    expect(findCuratedByUrl(`${sample.url}?utm_source=telegram`)?.id).toBe(sample.id);
    expect(findCuratedByUrl(normalizeUrl(sample.url))?.id).toBe(sample.id);
  });

  it('поиск по id работает', () => {
    expect(findCuratedById(CURATED_MENTIONS[5].id)).toBeDefined();
    expect(findCuratedById('999.999')).toBeUndefined();
  });

  it('статистика сходится с общим числом карточек', () => {
    const stats = getCuratedStats();
    expect(stats.positive + stats.neutral + stats.negative + stats.undefined).toBe(stats.total);
  });

  it('сообщение содержит заголовок, ссылку и пересказ', () => {
    const m = CURATED_MENTIONS[0];
    const text = formatCuratedMessage(m);
    expect(text).toContain(m.url);
    expect(text).toContain(m.summary.slice(0, 30));
    expect(text.length).toBeLessThan(4096); // лимит одного сообщения Telegram
  });

  it('ни одно сообщение не превышает лимит Telegram', () => {
    for (const m of CURATED_MENTIONS) {
      expect(formatCuratedMessage(m).length).toBeLessThan(4096);
    }
  });
});
