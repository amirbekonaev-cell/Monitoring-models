import { hashMentionText } from './hash.util';

describe('hashMentionText', () => {
  it('produces the same hash for identical title/text regardless of case and whitespace', () => {
    const a = hashMentionText('  Компания открыла завод  ', 'Текст новости');
    const b = hashMentionText('компания открыла завод', '  текст новости  ');
    expect(a).toBe(b);
  });

  it('produces different hashes for different content', () => {
    const a = hashMentionText('Компания открыла завод', 'Текст А');
    const b = hashMentionText('Компания открыла завод', 'Текст Б');
    expect(a).not.toBe(b);
  });

  it('returns a 64-character hex sha256 digest', () => {
    const hash = hashMentionText('title', 'text');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});
