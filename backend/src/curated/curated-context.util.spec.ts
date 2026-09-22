import { buildMentionContext } from './curated-context.util';

const FORMS = ['QazCloud', 'Казклауд'];

function filler(length: number, char = 'x'): string {
  return char.repeat(length);
}

describe('buildMentionContext', () => {
  it('always prepends the title', () => {
    const result = buildMentionContext('Заголовок', 'Текст про QazCloud.', FORMS);
    expect(result.startsWith('Заголовок')).toBe(true);
  });

  it('keeps the passage around a mention buried deep in a long article', () => {
    // The point of this function: a classifier reading only the first N characters of a long
    // round-up would never see the company at all.
    const body = `${filler(8000, 'a')} Компания QazCloud запустила дата-центр. ${filler(8000, 'b')}`;
    const result = buildMentionContext('Обзор рынка', body, FORMS, { windowChars: 100 });

    expect(result).toContain('QazCloud запустила дата-центр');
    expect(result).not.toContain(filler(500, 'a'));
  });

  it('merges two occurrences whose windows overlap into one passage', () => {
    const body = `начало QazCloud середина Казклауд конец`;
    const result = buildMentionContext('T', body, FORMS, { windowChars: 600 });

    expect(result).toContain('начало QazCloud середина Казклауд конец');
    expect(result).not.toContain('…');
  });

  it('keeps two distant occurrences as separate passages joined by an ellipsis', () => {
    const body = `QazCloud первый ${filler(4000, 'z')} QazCloud второй`;
    const result = buildMentionContext('T', body, FORMS, { windowChars: 50, maxChars: 100000 });

    expect(result).toContain(' … ');
    expect(result).toContain('QazCloud первый');
    expect(result).toContain('QazCloud второй');
  });

  it('matches case-insensitively', () => {
    const result = buildMentionContext('T', 'речь про qazcloud и его сервисы', FORMS, { windowChars: 20 });
    expect(result).toContain('qazcloud');
  });

  it('falls back to the start of the body when no form occurs literally', () => {
    // Relevance was already decided by the caller (Postgres FTS can match a declined form that
    // is not a literal substring) — this function picks an excerpt, it never vetoes.
    const result = buildMentionContext('T', 'Текст без прямого вхождения названия.', FORMS);
    expect(result).toContain('Текст без прямого вхождения названия.');
  });

  it('caps the result and marks the truncation', () => {
    const body = `QazCloud ${filler(20000, 'q')}`;
    const result = buildMentionContext('T', body, FORMS, { windowChars: 10000, maxChars: 4000 });

    expect(result.length).toBeLessThanOrEqual(4001);
    expect(result.endsWith('…')).toBe(true);
  });

  it('collapses whitespace so extracted HTML text stays readable', () => {
    const result = buildMentionContext('T', 'абв   \n\n\t  QazCloud   \n  где-то', FORMS, { windowChars: 50 });
    expect(result).toContain('абв QazCloud где-то');
  });

  it('returns just the title for an empty body', () => {
    expect(buildMentionContext('Только заголовок', '', FORMS)).toBe('Только заголовок');
  });

  it('ignores empty/whitespace terms instead of matching everywhere', () => {
    const result = buildMentionContext('T', 'абвгд', ['', '   '], { windowChars: 5 });
    expect(result).toContain('абвгд');
  });
});
