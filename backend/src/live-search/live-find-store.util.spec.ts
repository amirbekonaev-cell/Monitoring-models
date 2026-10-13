import { Sentiment } from '../mentions/mention.entity';
import { LiveFind } from './live-find.types';
import { liveFindsSettingKey, parseLiveFinds, serializeLiveFinds } from './live-find-store.util';

const NOW = new Date('2026-09-20T12:00:00Z');

function find(overrides: Partial<LiveFind> = {}): LiveFind {
  return {
    title: 'QazCloud открыл дата-центр',
    url: 'https://tengrinews.kz/news/1/',
    publishedAt: new Date('2026-09-19T10:00:00Z'),
    sourceName: 'Tengrinews',
    domain: 'tengrinews.kz',
    summary: 'Пересказ статьи.',
    sentiment: Sentiment.POSITIVE,
    ...overrides,
  };
}

describe('хранение находок живого поиска', () => {
  it('ключ — один на период', () => {
    expect(liveFindsSettingKey(7)).toBe('live_finds:7');
    expect(liveFindsSettingKey(7)).not.toBe(liveFindsSettingKey(90));
    // settings.key — varchar(100).
    expect(liveFindsSettingKey(100000).length).toBeLessThanOrEqual(100);
  });

  it('находка переживает запись и чтение без потерь', () => {
    const [restored] = parseLiveFinds(serializeLiveFinds([find()], NOW))!.finds;
    expect(restored).toEqual(find());
  });

  it('сохраняет момент записи — по нему потом считается окно периода', () => {
    expect(parseLiveFinds(serializeLiveFinds([find()], NOW))!.savedAt).toEqual(NOW);
  });

  it('материал без даты переживает чтение с null, а не с выдуманной датой', () => {
    const [restored] = parseLiveFinds(serializeLiveFinds([find({ publishedAt: null })], NOW))!.finds;
    expect(restored.publishedAt).toBeNull();
  });

  /** Пустой список — обычный результат: в тот раз живой поиск не нашёл ничего. */
  it('пустой список читается как пустой, а не как ошибка', () => {
    const stored = parseLiveFinds(serializeLiveFinds([], NOW));
    expect(stored).not.toBeNull();
    expect(stored!.finds).toEqual([]);
  });

  /** Сломанная запись не вправе решать, ответит бот человеку или нет. */
  it('мусор вместо JSON — null, без исключения', () => {
    expect(parseLiveFinds('не json')).toBeNull();
    expect(parseLiveFinds('')).toBeNull();
    expect(parseLiveFinds('{"finds":"строка"}')).toBeNull();
    expect(parseLiveFinds('null')).toBeNull();
  });

  it('непригодные находки выбрасываются поштучно, остальные остаются', () => {
    const raw = JSON.stringify({
      savedAt: NOW.toISOString(),
      finds: [
        { title: 'Без адреса', url: '', publishedAt: null, sourceName: '', domain: '', summary: null, sentiment: 'neutral' },
        { title: 'Битая дата', url: 'https://a.kz/1/', publishedAt: 'вчера', sourceName: '', domain: '', summary: null, sentiment: 'neutral' },
        { title: 'Годная', url: 'https://a.kz/2/', publishedAt: NOW.toISOString(), sourceName: 'A', domain: 'a.kz', summary: null, sentiment: 'neutral' },
      ],
    });

    const finds = parseLiveFinds(raw)!.finds;
    expect(finds.map((f) => f.title)).toEqual(['Годная']);
  });

  it('незнакомая тональность становится «не определена», а находка остаётся', () => {
    const raw = JSON.stringify({
      savedAt: NOW.toISOString(),
      finds: [{ title: 'T', url: 'https://a.kz/1/', publishedAt: null, sourceName: 'A', domain: 'a.kz', summary: null, sentiment: 'восторг' }],
    });

    expect(parseLiveFinds(raw)!.finds[0].sentiment).toBe(Sentiment.UNDEFINED);
  });

  it('запись без момента сохранения читается с savedAt = null', () => {
    const raw = JSON.stringify({ finds: [] });
    expect(parseLiveFinds(raw)!.savedAt).toBeNull();
  });
});
