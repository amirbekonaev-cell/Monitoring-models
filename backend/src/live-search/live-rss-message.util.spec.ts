import { LiveRssFind, LiveRssOutcome } from './live-rss-search.service';
import {
  LIVE_FINDS_PER_MESSAGE,
  buildLiveFindsMessages,
  buildLiveRssReportText,
} from './live-rss-message.util';

const TZ = 'Asia/Almaty';

function outcome(overrides: Partial<LiveRssOutcome> = {}): LiveRssOutcome {
  return {
    feedsTotal: 17,
    feedsOk: 17,
    feedsFailed: 0,
    itemsSeen: 1760,
    finds: [],
    alreadyKnown: 0,
    undated: 0,
    elapsedMs: 3200,
    ...overrides,
  };
}

function find(overrides: Partial<LiveRssFind> = {}): LiveRssFind {
  return {
    title: 'QazCloud открыл дата-центр',
    url: 'https://the-tech.kz/novaya-statya/',
    publishedAt: new Date('2026-10-11T10:00:00Z'),
    sourceName: 'The Tech',
    domain: 'the-tech.kz',
    snippet: 'Компания сообщила об открытии.',
    ...overrides,
  };
}

describe('buildLiveRssReportText', () => {
  /**
   * Отчёт уходит и когда находок нет: «опрошено 17 лент, 1760 материалов, нового нет» — это
   * проверяемое утверждение о работе, которая действительно была сделана за время ожидания.
   * Молчание в том же месте читалось бы как «поиск ничего не делал».
   */
  it('при нуле находок называет, сколько лент и материалов проверено', () => {
    const text = buildLiveRssReportText(outcome(), 'Неделя', TZ);

    expect(text).toContain('Опрошено лент: 17 из 17');
    expect(text).toContain('материалов просмотрено: 1760');
    expect(text).toContain('Новых упоминаний за Неделя в лентах нет.');
  });

  it('при находках называет их число', () => {
    const text = buildLiveRssReportText(outcome({ finds: [find(), find()] }), 'Месяц', TZ);

    expect(text).toContain('Новых упоминаний за Месяц: 2.');
  });

  /** Иначе «нового нет» значило бы разные вещи при 17 опрошенных лентах и при 3. */
  it('говорит про недоступные ленты, когда они были', () => {
    const text = buildLiveRssReportText(outcome({ feedsOk: 14, feedsFailed: 3 }), 'Неделя', TZ);

    expect(text).toContain('Опрошено лент: 14 из 17');
    expect(text).toContain('Недоступно лент: 3');
  });

  it('не пишет нулевых строк про недоступные ленты, дубли и материалы без даты', () => {
    const text = buildLiveRssReportText(outcome(), 'Неделя', TZ);

    expect(text).not.toContain('Недоступно лент');
    expect(text).not.toContain('уже есть в наборе');
    expect(text).not.toContain('Без даты');
  });

  it('сообщает про отброшенные дубли набора и материалы без даты, когда они есть', () => {
    const text = buildLiveRssReportText(outcome({ alreadyKnown: 2, undated: 5 }), 'Неделя', TZ);

    expect(text).toContain('уже есть в наборе');
    expect(text).toContain('Без даты публикации (в период поместить нечем): 5.');
  });

  /** Находки прохода человеком не проверены, и сообщение обязано это говорить. */
  it('помечает выдачу прохода как не проверенную вручную', () => {
    expect(buildLiveRssReportText(outcome(), 'Неделя', TZ)).toContain('не проверено вручную');
  });
});

describe('buildLiveFindsMessages', () => {
  it('находок нет — ни одного сообщения', () => {
    expect(buildLiveFindsMessages([], TZ)).toEqual([]);
  });

  it('дата в SEARCH_TIMEZONE, издание, заголовок и ссылка', () => {
    const [message] = buildLiveFindsMessages([find()], TZ);

    expect(message).toContain('1. 11.10.2026 · The Tech');
    expect(message).toContain('QazCloud открыл дата-центр');
    expect(message).toContain('🔗 https://the-tech.kz/novaya-statya/');
  });

  /** Тональность прохода никто не определял, и выдумывать её сообщение не вправе. */
  it('не приписывает находке тональность', () => {
    const [message] = buildLiveFindsMessages([find()], TZ);

    for (const word of ['Позитив', 'Негатив', 'Нейтрал', '🟢', '🔴', '🟡']) {
      expect(message).not.toContain(word);
    }
  });

  it('нумерация сквозная через все сообщения', () => {
    const finds = Array.from({ length: LIVE_FINDS_PER_MESSAGE + 2 }, (_, i) =>
      find({ url: `https://the-tech.kz/a-${i}/`, title: `Материал ${i}` }),
    );

    const messages = buildLiveFindsMessages(finds, TZ);

    expect(messages).toHaveLength(2);
    expect(messages[0]).toContain('1. ');
    expect(messages[1]).toContain(`${LIVE_FINDS_PER_MESSAGE + 1}. `);
    expect(messages[1]).toContain(`${LIVE_FINDS_PER_MESSAGE + 2}. `);
  });

  it('экранирует разметку в заголовке и ссылке', () => {
    const [message] = buildLiveFindsMessages(
      [find({ title: 'QazCloud <b>и</b> & партнёр', url: 'https://the-tech.kz/a?x=1&y=2' })],
      TZ,
    );

    expect(message).toContain('&lt;b&gt;');
    expect(message).toContain('&amp;');
    expect(message).not.toContain('<b>');
  });
});
