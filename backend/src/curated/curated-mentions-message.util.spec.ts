import {
  CURATED_MENTIONS_BATCH_SIZE,
  buildCuratedMoreCallbackData,
  buildCuratedSourceHeader,
  buildCuratedSourceUsageText,
  buildCuratedStatsText,
  parseCuratedMoreCallbackData,
} from './curated-mentions-message.util';
import { CURATED_MENTIONS, getCuratedBySource, getCuratedStats } from './curated-mentions';

describe('curated mentions: тексты и callback_data команд бота', () => {
  describe('buildCuratedMoreCallbackData / parseCuratedMoreCallbackData', () => {
    it('кодирует и разбирает домен и смещение без потерь', () => {
      const data = buildCuratedMoreCallbackData('sknews.kz', 8);
      expect(data).toBe('curated_more:sknews.kz:8');
      expect(parseCuratedMoreCallbackData(data!)).toEqual({ domain: 'sknews.kz', offset: 8 });
    });

    it('переживает домен с точками и дефисами (kz.kursiv.media, the-tech.kz)', () => {
      for (const domain of ['kz.kursiv.media', 'the-tech.kz', 'ru.sputnik.kz', 'aqmeshit-aptalygy.kz']) {
        const data = buildCuratedMoreCallbackData(domain, 16)!;
        expect(parseCuratedMoreCallbackData(data)).toEqual({ domain, offset: 16 });
      }
    });

    it('отказывается строить callback_data длиннее 64 байт — лимита Telegram', () => {
      expect(buildCuratedMoreCallbackData('a'.repeat(80), 0)).toBeNull();
    });

    it('отвергает отрицательное и нецелое смещение', () => {
      expect(buildCuratedMoreCallbackData('sknews.kz', -1)).toBeNull();
      expect(buildCuratedMoreCallbackData('sknews.kz', 1.5)).toBeNull();
    });

    it('отвергает мусор вместо callback_data, а не падает', () => {
      for (const bad of ['', 'curated_more', 'curated_more:sknews.kz', 'curated_more::8', 'search_more:7:3', 'curated_more:x:-1']) {
        expect(parseCuratedMoreCallbackData(bad)).toBeNull();
      }
    });

    it('callback_data каждого издания из набора укладывается в лимит', () => {
      for (const domain of new Set(CURATED_MENTIONS.map((m) => m.sourceDomain))) {
        expect(buildCuratedMoreCallbackData(domain, 48)).not.toBeNull();
      }
    });
  });

  describe('buildCuratedStatsText', () => {
    it('показывает общее число и разбивку по тональности', () => {
      const stats = getCuratedStats();
      const text = buildCuratedStatsText(stats, new Map([['SK News', 'sknews.kz']]));

      expect(text).toContain(`Всего: <b>${stats.total}</b>`);
      expect(text).toContain(`🟩 Позитив: ${stats.positive}`);
      expect(text).toContain(`🟨 Нейтрал: ${stats.neutral}`);
      expect(text).toContain(`🟥 Негатив: ${stats.negative}`);
      expect(text).toContain('<code>sknews.kz</code>');
    });

    it('не показывает строку «Не определена», когда таких карточек нет', () => {
      const stats = getCuratedStats();
      expect(stats.undefined).toBe(0);
      expect(buildCuratedStatsText(stats, new Map())).not.toContain('Не определена');
    });

    it('укладывается в лимит одного сообщения Telegram', () => {
      const domains = new Map(CURATED_MENTIONS.map((m) => [m.sourceName, m.sourceDomain]));
      expect(buildCuratedStatsText(getCuratedStats(), domains).length).toBeLessThan(4096);
    });
  });

  describe('buildCuratedSourceUsageText', () => {
    it('подсказывает формат, когда издание не указано', () => {
      const text = buildCuratedSourceUsageText(null, ['sknews.kz', 'profit.kz']);
      expect(text).toContain('Укажите издание');
      expect(text).toContain('sknews.kz');
    });

    it('сообщает, что издание не найдено, и экранирует пользовательский ввод', () => {
      const text = buildCuratedSourceUsageText('<script>alert(1)</script>', ['sknews.kz']);
      expect(text).toContain('не найдено');
      expect(text).not.toContain('<script>');
      expect(text).toContain('&lt;script&gt;');
    });
  });

  describe('buildCuratedSourceHeader', () => {
    it('у маленького издания не обещает несуществующих страниц', () => {
      const items = getCuratedBySource('the-tenge.kz');
      expect(items.length).toBeLessThanOrEqual(CURATED_MENTIONS_BATCH_SIZE);
      const header = buildCuratedSourceHeader(items, 'the-tenge.kz', 0);
      expect(header).toContain(`карточек: ${items.length}`);
      expect(header).not.toContain('показаны');
    });

    it('у большого издания показывает границы текущей пачки', () => {
      const items = getCuratedBySource('sknews.kz');
      expect(buildCuratedSourceHeader(items, 'sknews.kz', 0)).toContain('показаны 1–8');
      expect(buildCuratedSourceHeader(items, 'sknews.kz', 8)).toContain('показаны 9–16');
    });

    it('на последней, неполной пачке не выходит за число карточек', () => {
      const items = getCuratedBySource('sknews.kz');
      const lastOffset = Math.floor((items.length - 1) / CURATED_MENTIONS_BATCH_SIZE) * CURATED_MENTIONS_BATCH_SIZE;
      expect(buildCuratedSourceHeader(items, 'sknews.kz', lastOffset)).toContain(`–${items.length}`);
    });
  });
});
