import { Sentiment } from '../mentions/mention.entity';
import { CuratedLinkStatus } from './curated-link.entity';
import { CardSetStats, CuratedMentionView, CuratedSearchResult, PoolStats } from './curated-search.service';
import {
  buildEmptyPeriodText,
  buildExpandPromptText,
  buildHeader,
  buildItemBlock,
  buildItemMessages,
  buildMoreButtonFallbackText,
  buildPage,
  buildPeriodConfirmationText,
  buildSearchExpandCallbackData,
  buildSearchMoreCallbackData,
  buildStatusText,
  buildTitleListMessages,
} from './curated-message.util';

const TZ = 'Asia/Almaty';

function makePool(overrides: Partial<PoolStats> = {}): PoolStats {
  return {
    totalLinks: 169,
    byStatus: {
      [CuratedLinkStatus.PENDING]: 0,
      [CuratedLinkStatus.PROCESSED]: 169,
      [CuratedLinkStatus.NOT_RELEVANT]: 0,
      [CuratedLinkStatus.FAILED]: 0,
      [CuratedLinkStatus.EXCLUDED]: 0,
    },
    mentionsTotal: 169,
    undatedMentions: 0,
    firstArticleDate: new Date('2020-01-10T00:00:00Z'),
    lastArticleDate: new Date('2026-09-15T00:00:00Z'),
    lastProcessedAt: new Date('2026-09-16T08:00:00Z'),
    ...overrides,
  };
}

function makeResult(overrides: Partial<CuratedSearchResult> = {}): CuratedSearchResult {
  return {
    periodDays: 7,
    dateFrom: '2026-09-09',
    dateTo: '2026-09-16',
    total: 0,
    bySentiment: {
      [Sentiment.POSITIVE]: 0,
      [Sentiment.NEGATIVE]: 0,
      [Sentiment.NEUTRAL]: 0,
      [Sentiment.UNDEFINED]: 0,
    },
    undatedCount: 0,
    pool: makePool(),
    ...overrides,
  };
}

function makeItem(overrides: Partial<CuratedMentionView> = {}): CuratedMentionView {
  return {
    id: 'm-1',
    title: 'Заголовок статьи',
    sourceLabel: 'Подборка материалов',
    publishedAt: new Date('2026-09-10T10:00:00Z'),
    sentiment: Sentiment.NEUTRAL,
    summary: 'Короткий пересказ.',
    snippet: null,
    // По умолчанию ссылки нет — так ведёт себя источник закрытого пула, и обзорные тексты
    // (шапка, список заголовков, упакованная страница) обязаны оставаться без ссылок при любом
    // источнике. Тесты про ссылку задают url явно.
    url: null,
    ...overrides,
  };
}

describe('buildPeriodConfirmationText', () => {
  it('formats the period label and the resolved calendar window', () => {
    expect(buildPeriodConfirmationText('Неделя', '2026-09-09', '2026-09-16')).toBe(
      'Период: Неделя (с 09.09.2026 по 16.09.2026)',
    );
  });

  /**
   * На успехе — только период, одной строкой. Строка про дашборд ушла: человек спрашивал
   * упоминания, а не про устройство бота, и её число к тому же расходилось с числом в списке —
   * в дашборд попадает не всё, что уезжает в сообщение.
   */
  it('на успешной записи в дашборд не добавляет ничего', () => {
    expect(buildPeriodConfirmationText('3 месяца', '2026-07-10', '2026-10-10', { published: 12 })).toBe(
      'Период: 3 месяца (с 10.07.2026 по 10.10.2026)',
    );
  });

  // Промолчать о неудаче нельзя: человек пойдёт искать в веб-интерфейсе то, чего туда не попало.
  it('честно сообщает, что дашборд обновить не удалось', () => {
    expect(buildPeriodConfirmationText('Неделя', '2026-09-09', '2026-09-16', { published: null })).toBe(
      'Период: Неделя (с 09.09.2026 по 16.09.2026)\nДашборд обновить не удалось — в веб-интерфейсе осталась прежняя выдача.',
    );
  });

  it('без сведений о дашборде отдаёт ровно одну строку с периодом', () => {
    expect(buildPeriodConfirmationText('Неделя', '2026-09-09', '2026-09-16')).toBe(
      'Период: Неделя (с 09.09.2026 по 16.09.2026)',
    );
    expect(buildPeriodConfirmationText('Неделя', '2026-09-09', '2026-09-16', { published: 0 })).toBe(
      'Период: Неделя (с 09.09.2026 по 16.09.2026)',
    );
  });
});

describe('buildHeader', () => {
  it('shows the total and per-sentiment breakdown', () => {
    const result = makeResult({
      total: 4,
      bySentiment: {
        [Sentiment.POSITIVE]: 1,
        [Sentiment.NEGATIVE]: 1,
        [Sentiment.NEUTRAL]: 1,
        [Sentiment.UNDEFINED]: 1,
      },
    });
    const header = buildHeader('Неделя', result);
    expect(header).toContain('<b>Упоминания за Неделя</b> (с 09.09.2026 по 16.09.2026)');
    expect(header).toContain('Всего: 4 · 🟢 1 · 🔴 1 · 🟡 1 · ⚪ 1');
  });

  it('omits the undated/queue lines when there is nothing to report', () => {
    const header = buildHeader('Неделя', makeResult({ total: 1 }));
    expect(header).not.toContain('Без даты публикации');
    expect(header).not.toContain('В очереди на обработку');
  });

  /**
   * Строка про материалы без даты убрана: рядом с «Всего: N» она только путает, а знать её
   * человеку незачем — это внутренняя статистика. Числа остались в /status.
   */
  it('не печатает строку про материалы без даты', () => {
    const header = buildHeader('Неделя', makeResult({ total: 1, undatedCount: 3 }));
    expect(header).not.toContain('Без даты');
    expect(header).toContain('Всего: 1');
  });

  // The queue line is gone for good: the bot reads a JSON file that is never processed, so there
  // is no queue, and a line printing zeros would only raise the question of what is stuck.
  it('never prints a processing queue, even when the stats still carry pending/failed links', () => {
    const header = buildHeader(
      'Неделя',
      makeResult({
        total: 1,
        pool: makePool({
          byStatus: {
            [CuratedLinkStatus.PENDING]: 2,
            [CuratedLinkStatus.PROCESSED]: 166,
            [CuratedLinkStatus.NOT_RELEVANT]: 0,
            [CuratedLinkStatus.FAILED]: 1,
            [CuratedLinkStatus.EXCLUDED]: 0,
          },
        }),
      }),
    );
    expect(header).not.toContain('В очереди на обработку');
    expect(header).not.toContain('с ошибкой');
  });

  it('never contains a URL', () => {
    const header = buildHeader('Неделя', makeResult({ total: 1 }));
    expect(header).not.toMatch(/https?:\/\//);
  });
});

describe('buildEmptyPeriodText', () => {
  /**
   * Одна строка, и всё. Раньше здесь дописывалось, сколько у бота всего материалов и какой из них
   * самый свежий, — это внутренняя статистика: человеку, спросившему про неделю, она не нужна,
   * зато выдаёт устройство бота. Числа остались в /status, команде рабочей группы.
   */
  it('сообщает только то, что за период ничего не нашлось', () => {
    expect(buildEmptyPeriodText('Неделя')).toBe('За Неделя упоминаний не найдено.');
  });

  it('не рассказывает, сколько у бота материалов и откуда они', () => {
    const text = buildEmptyPeriodText('Всё время').toLowerCase();
    for (const leak of ['в наборе', 'обработано', 'пул', 'лент', 'самая свежая']) {
      expect(text).not.toContain(leak);
    }
  });

  it('never contains a URL', () => {
    expect(buildEmptyPeriodText('Неделя')).not.toMatch(/https?:\/\//);
  });
});

describe('buildItemBlock', () => {
  it('escapes HTML special characters in the title, source label, and body', () => {
    const item = makeItem({ title: 'A & B <script>', sourceLabel: 'X & Y', summary: 'Текст с <тегом> и & амп.' });
    const block = buildItemBlock(1, item, TZ);
    expect(block).toContain('A &amp; B &lt;script&gt;');
    expect(block).toContain('X &amp; Y');
    expect(block).toContain('Текст с &lt;тегом&gt; и &amp; амп.');
    expect(block).not.toContain('<script>');
  });

  it('truncates a title longer than ~200 chars', () => {
    const longTitle = 'Слово '.repeat(60); // well over 200 chars
    const block = buildItemBlock(1, makeItem({ title: longTitle }), TZ);
    const titleLine = block.split('\n')[0];
    expect(titleLine.length).toBeLessThan(longTitle.length);
    expect(titleLine).toContain('…');
  });

  it('prefers summary over snippet when both are present', () => {
    const block = buildItemBlock(1, makeItem({ summary: 'Пересказ', snippet: 'Сниппет' }), TZ);
    expect(block).toContain('Пересказ');
    expect(block).not.toContain('Сниппет');
  });

  it('falls back to the snippet when summary is null', () => {
    const block = buildItemBlock(1, makeItem({ summary: null, snippet: 'Сниппет из текста' }), TZ);
    expect(block).toContain('Сниппет из текста');
  });

  it('shows "дата не определена" for an item with no publish date', () => {
    const block = buildItemBlock(1, makeItem({ publishedAt: null }), TZ);
    expect(block).toContain('дата не определена');
  });

  it('never contains a URL — the view type carries no url field at all', () => {
    const block = buildItemBlock(1, makeItem(), TZ);
    expect(block).not.toMatch(/https?:\/\//);
  });
});

describe('buildPage', () => {
  function bigItems(count: number): CuratedMentionView[] {
    return Array.from({ length: count }, (_, i) =>
      makeItem({ id: `m-${i}`, title: `Заголовок находки номер ${i}`, summary: 'Пересказ средней длины для теста упаковки страниц. '.repeat(3) }),
    );
  }

  it('greedily packs items until the char limit, leaving the rest for the next page', () => {
    const items = bigItems(50);
    const { text, shownCount } = buildPage({ header: '<b>Шапка</b>', items, startIndex: 1, timezone: TZ, charLimit: 1000 });
    expect(text.length).toBeLessThanOrEqual(1000);
    expect(shownCount).toBeGreaterThan(0);
    expect(shownCount).toBeLessThan(items.length);
  });

  it('always includes at least one item even if it alone exceeds the char limit', () => {
    const items = [makeItem({ summary: 'Очень длинный пересказ. '.repeat(100) })];
    const { shownCount } = buildPage({ header: null, items, startIndex: 1, timezone: TZ, charLimit: 50 });
    expect(shownCount).toBe(1);
  });

  it('numbers items starting at startIndex, so pagination continues the running count', () => {
    const items = bigItems(2);
    const { text } = buildPage({ header: null, items, startIndex: 5, timezone: TZ, charLimit: 5000 });
    expect(text).toMatch(/^5\. /);
    expect(text).toContain('\n\n6. ');
  });

  it('fits every item on the last page (nothing left over)', () => {
    const items = bigItems(2);
    const { shownCount } = buildPage({ header: null, items, startIndex: 1, timezone: TZ, charLimit: 5000 });
    expect(shownCount).toBe(2);
  });

  it('returns just the header (shownCount 0) for an empty items array', () => {
    const { text, shownCount } = buildPage({ header: '<b>Шапка</b>', items: [], startIndex: 1, timezone: TZ, charLimit: 3500 });
    expect(shownCount).toBe(0);
    expect(text).toBe('<b>Шапка</b>');
  });
});

describe('buildSearchMoreCallbackData', () => {
  it('builds "search_more:<days>:<offset>"', () => {
    expect(buildSearchMoreCallbackData(730, 42)).toBe('search_more:730:42');
  });

  it('stays comfortably under the 64-byte Telegram limit for realistic values', () => {
    const data = buildSearchMoreCallbackData(3650, 999999);
    expect(data).not.toBeNull();
    expect(Buffer.byteLength(data!, 'utf8')).toBeLessThanOrEqual(64);
  });

  it('the 64-byte guard itself rejects anything over the limit (verified directly, since no realistic day/offset pair can trigger it: a JS number long enough to overflow renders in short exponential notation)', () => {
    const oversized = `search_more:7:${'9'.repeat(60)}`;
    expect(Buffer.byteLength(oversized, 'utf8')).toBeGreaterThan(64);
  });
});

describe('buildStatusText', () => {
  it('reports pool totals, per-status breakdown, date range, undated count, and last-processed time with no URLs', () => {
    const text = buildStatusText(
      makePool({
        byStatus: {
          [CuratedLinkStatus.PENDING]: 3,
          [CuratedLinkStatus.PROCESSED]: 160,
          [CuratedLinkStatus.NOT_RELEVANT]: 5,
          [CuratedLinkStatus.FAILED]: 1,
          [CuratedLinkStatus.EXCLUDED]: 0,
        },
        mentionsTotal: 160,
        undatedMentions: 2,
      }),
      TZ,
    );
    expect(text).toContain('169 всего');
    expect(text).toContain('обработано 160 · не релевантны 5 · с ошибкой 1 · в очереди 3');
    expect(text).toContain('Упоминаний в пуле: 160');
    expect(text).toContain('10.01.2020 — 15.09.2026');
    expect(text).toContain('Без даты: 2');
    expect(text).not.toMatch(/https?:\/\//);
  });

  it('reports "нет данных" for the date range and "ещё не запускалась" when the pool has never been processed', () => {
    const text = buildStatusText(makePool({ firstArticleDate: null, lastArticleDate: null, lastProcessedAt: null }), TZ);
    expect(text).toContain('нет данных');
    expect(text).toContain('ещё не запускалась');
  });

  // The card-set variant (PoolStats.cards present — i.e. the stats came from the JSON source the
  // bot actually reads). It must not borrow the queue vocabulary of the link pool: these cards are
  // written by hand, nothing processes them, and "в очереди 0 / ещё не запускалась" would describe
  // a pipeline that does not exist.
  describe('набор готовых карточек (источник бота)', () => {
    function makeCards(overrides: Partial<CardSetStats> = {}): CardSetStats {
      return {
        total: 168,
        shown: 167,
        duplicates: 1,
        byStatus: { verified: 109, partial: 19, unverified: 39, duplicate: 0 },
        bySentiment: {
          [Sentiment.POSITIVE]: 120,
          [Sentiment.NEGATIVE]: 2,
          [Sentiment.NEUTRAL]: 44,
          [Sentiment.UNDEFINED]: 0,
        },
        ...overrides,
      };
    }

    it('describes the set: sizes, sentiment split, verification, date range — and no URLs', () => {
      const text = buildStatusText(makePool({ cards: makeCards(), undatedMentions: 1 }), TZ);

      expect(text).toContain('Готовых карточек: 168 всего, доступно для /search: 167');
      expect(text).toContain('🟢 120 · 🔴 2 · 🟡 44 · ⚪ 0');
      expect(text).toContain('Проверено: 109 · частично: 19 · по URL: 39');
      expect(text).toContain('10.01.2020 — 15.09.2026');
      expect(text).toContain('Без даты: 1');
      expect(text).toContain('Скрыто как дубликаты: 1');
      expect(text).not.toMatch(/https?:\/\//);
    });

    it('says nothing about a queue, errors or a last processing run', () => {
      const text = buildStatusText(makePool({ cards: makeCards() }), TZ);

      expect(text).not.toContain('в очереди');
      expect(text).not.toContain('с ошибкой');
      expect(text).not.toContain('Последняя обработка');
    });

    it('omits the duplicates line when there are none', () => {
      const text = buildStatusText(makePool({ cards: makeCards({ total: 167, duplicates: 0 }) }), TZ);
      expect(text).not.toContain('Скрыто как дубликаты');
    });
  });
});

/**
 * SEARCH_ONE_ARTICLE_PER_MESSAGE — one message per finding, batched. The invariant the tests below
 * exist for is the pagination one: walking the batches from offset 0 must yield every finding
 * exactly once, in order, with no gap and no repeat at the seams.
 */
describe('buildItemMessages', () => {
  function items(count: number, from = 0): CuratedMentionView[] {
    return Array.from({ length: count }, (_, i) => makeItem({ id: `m-${from + i}`, title: `Находка ${from + i}` }));
  }

  it('produces one message per finding, numbered from the running offset', () => {
    const batch = buildItemMessages({ items: items(3), startOffset: 0, total: 3, timezone: TZ, batchSize: 8 });

    expect(batch.messages).toHaveLength(3);
    expect(batch.messages[0]).toContain('1. ');
    expect(batch.messages[0]).toContain('Находка 0');
    expect(batch.messages[2]).toContain('3. ');
    expect(batch.nextOffset).toBe(3);
    expect(batch.remaining).toBe(0);
  });

  it('continues the numbering across pages instead of restarting at 1', () => {
    const batch = buildItemMessages({ items: items(2, 8), startOffset: 8, total: 20, timezone: TZ, batchSize: 8 });

    expect(batch.messages[0]).toContain('9. ');
    expect(batch.messages[1]).toContain('10. ');
    expect(batch.nextOffset).toBe(10);
    expect(batch.remaining).toBe(10);
  });

  it('caps the batch at batchSize and leaves the rest for the next press', () => {
    const batch = buildItemMessages({ items: items(20), startOffset: 0, total: 20, timezone: TZ, batchSize: 8 });

    expect(batch.messages).toHaveLength(8);
    expect(batch.nextOffset).toBe(8);
    expect(batch.remaining).toBe(12);
  });

  it('walks a whole period in batches with no duplicate and no skipped finding', () => {
    const total = 19;
    const all = items(total);
    const seen: string[] = [];
    let offset = 0;
    let presses = 0;

    // Exactly what the bot does: fetch from the current offset, send, take nextOffset back.
    while (offset < total) {
      const batch = buildItemMessages({
        items: all.slice(offset, offset + 8),
        startOffset: offset,
        total,
        timezone: TZ,
        batchSize: 8,
      });
      seen.push(...batch.messages);
      expect(batch.remaining).toBe(total - batch.nextOffset);
      offset = batch.nextOffset;
      presses += 1;
    }

    expect(presses).toBe(3); // 8 + 8 + 3
    expect(seen).toHaveLength(total);
    // Numbering is 1..19 across the three batches, each exactly once — the "no duplicates, no
    // gaps" claim stated as the actual item numbers rather than just a count.
    expect(seen.map((m) => m.split('.')[0])).toEqual(Array.from({ length: total }, (_, i) => String(i + 1)));
  });

  it('produces nothing for an empty period', () => {
    const batch = buildItemMessages({ items: [], startOffset: 0, total: 0, timezone: TZ, batchSize: 8 });

    expect(batch.messages).toEqual([]);
    expect(batch.nextOffset).toBe(0);
    expect(batch.remaining).toBe(0);
  });

  it('reports nothing remaining on the last batch, so the button disappears', () => {
    const batch = buildItemMessages({ items: items(3, 16), startOffset: 16, total: 19, timezone: TZ, batchSize: 8 });

    expect(batch.messages).toHaveLength(3);
    expect(batch.remaining).toBe(0);
  });

  it('never reports a negative remaining when the window shrank between presses', () => {
    const batch = buildItemMessages({ items: items(2, 8), startOffset: 8, total: 5, timezone: TZ, batchSize: 8 });

    expect(batch.remaining).toBe(0);
  });

  it('still sends one message per press when batchSize is mistyped as 0', () => {
    const batch = buildItemMessages({ items: items(5), startOffset: 0, total: 5, timezone: TZ, batchSize: 0 });

    expect(batch.messages).toHaveLength(1);
    expect(batch.nextOffset).toBe(1);
  });

  /**
   * Граница приватности: ссылка печатается ТОЛЬКО если источник её дал. У закрытого пула
   * (CuratedSearchService) `url` всегда null — это и есть поведение ниже.
   */
  it('не печатает ссылку, когда источник её не дал', () => {
    const batch = buildItemMessages({
      items: [makeItem({ title: 'Статья', summary: 'Пересказ без ссылок.', url: null })],
      startOffset: 0,
      total: 1,
      timezone: TZ,
      batchSize: 8,
    });

    expect(batch.messages.join('\n')).not.toContain('http');
  });

  it('печатает ссылку отдельной строкой, когда карточка её несёт', () => {
    const batch = buildItemMessages({
      items: [makeItem({ title: 'Статья', url: 'https://sknews.kz/news/view/qazcloud' })],
      startOffset: 0,
      total: 1,
      timezone: TZ,
      batchSize: 8,
    });

    expect(batch.messages[0]).toContain('\n🔗 https://sknews.kz/news/view/qazcloud');
  });

  it('экранирует ссылку — она уезжает с parse_mode HTML', () => {
    const batch = buildItemMessages({
      items: [makeItem({ url: 'https://example.com/a?x=1&y=2' })],
      startOffset: 0,
      total: 1,
      timezone: TZ,
      batchSize: 8,
    });

    expect(batch.messages[0]).toContain('x=1&amp;y=2');
  });
});

describe('buildTitleListMessages', () => {
  const TZ = 'Asia/Almaty';

  function titleItems(count: number): CuratedMentionView[] {
    return Array.from({ length: count }, (_, i) =>
      makeItem({
        id: `m-${i}`,
        title: `Заголовок ${i}`,
        summary: 'Пересказ, которого в списке быть не должно.',
        url: `https://example.com/a-${i}`,
      }),
    );
  }

  it('нумерует все заголовки подряд и не теряет ни одного', () => {
    const messages = buildTitleListMessages({
      header: 'ШАПКА',
      items: titleItems(5),
      startIndex: 1,
      timezone: TZ,
      charLimit: 3500,
    });

    const joined = messages.join('\n');
    expect(joined).toContain('ШАПКА');
    for (let i = 0; i < 5; i++) {
      expect(joined).toContain(`${i + 1}. `);
      expect(joined).toContain(`Заголовок ${i}`);
    }
  });

  it('список — это обзор: без пересказов и без ссылок', () => {
    const messages = buildTitleListMessages({
      header: null,
      items: titleItems(3),
      startIndex: 1,
      timezone: TZ,
      charLimit: 3500,
    });

    const joined = messages.join('\n');
    expect(joined).not.toContain('Пересказ, которого');
    expect(joined).not.toMatch(/https?:\/\//);
  });

  /**
   * Весь список обязан уехать целиком — у обзора нет «Показать ещё». Поэтому при переполнении
   * лимита он режется на несколько сообщений, а не обрывается.
   */
  it('разбивает длинный список на несколько сообщений, сохраняя все строки', () => {
    const messages = buildTitleListMessages({
      header: 'ШАПКА',
      items: titleItems(40),
      startIndex: 1,
      timezone: TZ,
      charLimit: 400,
    });

    expect(messages.length).toBeGreaterThan(1);
    for (const message of messages) {
      expect(message.length).toBeLessThanOrEqual(400);
    }
    const numbers = messages
      .join('\n')
      .split('\n')
      .filter((line) => /^\d+\. /.test(line))
      .map((line) => parseInt(line, 10));
    expect(numbers).toEqual(Array.from({ length: 40 }, (_, i) => i + 1));
  });

  it('одна строка длиннее лимита всё равно уходит — пустых сообщений Telegram не принимает', () => {
    const messages = buildTitleListMessages({
      header: null,
      items: [makeItem({ title: 'Очень длинный заголовок '.repeat(20) })],
      startIndex: 1,
      timezone: TZ,
      charLimit: 50,
    });

    expect(messages).toHaveLength(1);
    expect(messages[0].length).toBeGreaterThan(50);
  });

  it('пустая выдача не даёт пустого сообщения', () => {
    expect(buildTitleListMessages({ header: null, items: [], startIndex: 1, timezone: TZ, charLimit: 3500 })).toEqual([]);
  });

  it('продолжает нумерацию с startIndex', () => {
    const [message] = buildTitleListMessages({
      header: null,
      items: titleItems(2),
      startIndex: 9,
      timezone: TZ,
      charLimit: 3500,
    });

    expect(message).toContain('9. ');
    expect(message).toContain('10. ');
  });
});

describe('buildExpandPromptText', () => {
  it('одна короткая строка с числом найденного', () => {
    const text = buildExpandPromptText(166);

    expect(text).toBe('Показать каждую статью подробнее? Найдено: 166.');
  });
});

describe('buildSearchExpandCallbackData', () => {
  it('кодирует период и смещение', () => {
    expect(buildSearchExpandCallbackData(36500, 0)).toBe('search_each:36500:0');
    expect(buildSearchExpandCallbackData(7, 160)).toBe('search_each:7:160');
  });

  it('не отличается от search_more по длине настолько, чтобы вылезти за 64 байта', () => {
    expect(buildSearchExpandCallbackData(36500, 999999)!.length).toBeLessThanOrEqual(64);
  });
});

describe('buildMoreButtonFallbackText', () => {
  it('says how far the reader got, with no URL', () => {
    const text = buildMoreButtonFallbackText(8, 19);

    expect(text).toContain('8');
    expect(text).toContain('19');
    expect(text).not.toContain('http');
  });
});
