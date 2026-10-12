import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RssService, ParsedRssItem } from '../collectors/rss/rss.service';
import { hasCurated, normalizeUrl } from '../curated/curated-mentions';
import { subtractCalendarDays, zonedDateString } from '../curated/curated-date.util';
import { ALL_TIME_PERIOD_DAYS } from '../curated/search-period.util';
import { Sentiment } from '../mentions/mention.entity';
import { matchesBrand, parseBrandForms } from './brand-match.util';
import { LiveFind } from './live-find.types';
import rawFeeds from './live-feeds.data.json';

/** Одна лента: публикация, её домен и адрес фида. */
export interface LiveFeed {
  sourceName: string;
  domain: string;
  feedUrl: string;
}

export const LIVE_FEEDS: LiveFeed[] = rawFeeds as LiveFeed[];

/** Чем закончился проход — всё это уходит в сообщение, чтобы отчёт был проверяемым. */
export interface LiveRssOutcome {
  feedsTotal: number;
  feedsOk: number;
  feedsFailed: number;
  itemsSeen: number;
  finds: LiveFind[];
  /** Совпадения, уже имеющиеся в наборе карточек, — в finds они не попадают. */
  alreadyKnown: number;
  /** Совпадения без даты: поместить их в период нечем, поэтому они не показываются. */
  undated: number;
  elapsedMs: number;
}

const SNIPPET_MAX_CHARS = 200;

/** Потолок на ОДНУ ленту. Замерено: самая медленная из 17 отдаётся за ~3.2 с. */
const DEFAULT_FEED_TIMEOUT_MS = 8000;

/** Потолок на обход лент. 17 лент параллельно укладываются в ~3.2 с — это запас втрое. */
const DEFAULT_BUDGET_MS = 12000;

/**
 * Живой проход по RSS-лентам изданий — единственный канал сбора, который успевает отработать
 * внутри запроса.
 *
 * Зачем он здесь и чего от него ждать. Набор из 167 карточек закрыт и описывает прошлое; этот
 * проход отвечает на другой вопрос — «не появилось ли НОВОГО упоминания прямо сейчас». Лента
 * отдаёт только последние 10–100 материалов, поэтому восстановить по ней историю невозможно и
 * никто от неё этого не ждёт: она ловит упоминание в день публикации. Замерено на реальной сети:
 * 17 лент параллельно — 3.2 с, 1760 материалов, у всех 1760 есть дата.
 *
 * Почему именно RSS, а не парсер сайтов и не веб-поиск OpenAI (замеры — в README, раздел «Живой
 * проход по лентам»): обход 26 сайтов парсером стоит 20–25 с даже на глубине «одна страница
 * листинга», отдаёт текст-тизер в десятки символов и у большинства сайтов вовсе без даты, а один
 * запрос веб-поиска OpenAI — 12–14 с, платный, и возвращает сайт самой компании, бизнес-реестры и
 * конкурента вместо новостей. Ленты дают датированные материалы и стоят три секунды.
 *
 * Три свойства, которые проход обязан сохранять:
 *  - **никогда не роняет /search.** Каждая лента изолирована, упавшие только считаются (как в
 *    runCollectionCycle: одна битая лента не вправе унести остальные), а весь проход вызывается
 *    из обработчика внутри try/catch;
 *  - **никогда не выходит за бюджет.** Свой потолок у каждой ленты и у прохода целиком, оба —
 *    внешним Promise.race, а не параметром `timeout` у rss-parser: на первом же замере лента
 *    зависла на минуты, несмотря на выставленные ему 15 с;
 *  - **не трогает ни базу, ни OpenAI.** Список лент лежит в live-feeds.data.json, формы названия
 *    компании — в brand-match.util.ts, сверка с набором идёт через hasCurated() по JSON. /search
 *    обязан работать и без базы, и без OPENAI_API_KEY — см. комментарий класса TelegramBotService.
 */
@Injectable()
export class LiveRssSearchService {
  private readonly logger = new Logger(LiveRssSearchService.name);

  constructor(
    private readonly rss: RssService,
    private readonly config: ConfigService,
  ) {}

  get feedCount(): number {
    return LIVE_FEEDS.length;
  }

  /** SEARCH_LIVE_RSS: включён по умолчанию, выключается только явным `false`. */
  private get enabled(): boolean {
    return this.config.get<boolean>('liveSearch.enabled') !== false;
  }

  private get budgetMs(): number {
    return positiveInt(this.config.get<number>('liveSearch.rssBudgetMs'), DEFAULT_BUDGET_MS);
  }

  private get feedTimeoutMs(): number {
    return positiveInt(this.config.get<number>('liveSearch.feedTimeoutMs'), DEFAULT_FEED_TIMEOUT_MS);
  }

  private get timezone(): string {
    return this.config.get<string>('curated.timezone') || 'Asia/Almaty';
  }

  /**
   * Один проход по всем лентам: качает их параллельно, оставляет материалы с названием компании,
   * выбрасывает те, что уже есть в наборе карточек, и отдаёт остальное от новых к старым.
   *
   * `now` и `periodDays` задают то же окно календарных дней в SEARCH_TIMEZONE, что у /search, —
   * иначе находка могла бы не совпасть с периодом, указанным в шапке сообщения. «Всё время» окна
   * не ограничивает: у лент и так нет ничего старше нескольких недель.
   */
  async collect(periodDays: number, now: Date = new Date()): Promise<LiveRssOutcome> {
    const startedAt = Date.now();
    if (!this.enabled) {
      return emptyOutcome(0);
    }

    const deadline = startedAt + this.budgetMs;
    const forms = parseBrandForms(this.config.get<string>('liveSearch.brandForms'));
    const dateTo = zonedDateString(now, this.timezone);
    const dateFrom = periodDays >= ALL_TIME_PERIOD_DAYS ? null : subtractCalendarDays(dateTo, periodDays);

    const outcome = emptyOutcome(LIVE_FEEDS.length);
    const seenUrls = new Set<string>();

    const perFeed = await Promise.all(LIVE_FEEDS.map((feed) => this.readFeed(feed, deadline)));

    for (const { feed, items, error } of perFeed) {
      if (error) {
        outcome.feedsFailed += 1;
        // Предупреждение, а не ошибка: недоступная лента — обычное дело, и /search от неё не
        // зависит. Причина пишется целиком, чтобы было видно, лента упала или зависла.
        this.logger.warn(`Живой проход: лента ${feed.feedUrl} недоступна — ${error}`);
        continue;
      }

      outcome.feedsOk += 1;
      outcome.itemsSeen += items.length;

      for (const item of items) {
        if (!matchesBrand(forms, item.title, item.text)) {
          continue;
        }

        // Уже проверенная человеком карточка: показывать её второй раз как «новое» нельзя.
        if (hasCurated(item.url)) {
          outcome.alreadyKnown += 1;
          continue;
        }

        if (!item.publishedAt || Number.isNaN(item.publishedAt.getTime())) {
          outcome.undated += 1;
          continue;
        }

        const day = zonedDateString(item.publishedAt, this.timezone);
        if ((dateFrom !== null && day < dateFrom) || day > dateTo) {
          continue;
        }

        // Одна и та же новость часто стоит сразу в нескольких лентах одного издательского дома.
        const key = normalizeUrl(item.url);
        if (seenUrls.has(key)) {
          continue;
        }
        seenUrls.add(key);

        outcome.finds.push({
          title: item.title,
          url: item.url,
          publishedAt: item.publishedAt,
          sourceName: feed.sourceName,
          domain: feed.domain,
          // Описание из фида — это тизер, а не пересказ, но лучше него у ленты ничего нет.
          summary: item.text ? item.text.slice(0, SNIPPET_MAX_CHARS).trim() || null : null,
          // Тональность по ленте не определяется: выдумывать её нечем, а врать нельзя. Веб-поиск
          // отдаёт её сам (см. OpenAiNewsSearchService), у ленты остаётся «не определена».
          sentiment: Sentiment.UNDEFINED,
        });
      }
    }

    outcome.finds.sort((a, b) => (b.publishedAt as Date).getTime() - (a.publishedAt as Date).getTime());
    outcome.elapsedMs = Date.now() - startedAt;

    this.logger.log(
      `Живой проход по лентам: ${outcome.feedsOk}/${outcome.feedsTotal} доступно, материалов ` +
        `${outcome.itemsSeen}, новых упоминаний за период ${outcome.finds.length} ` +
        `(уже в наборе: ${outcome.alreadyKnown}, без даты: ${outcome.undated}), ${outcome.elapsedMs} мс`,
    );

    return outcome;
  }

  /**
   * Одна лента под двумя потолками: своим и общим бюджетом прохода, что бы из них ни кончилось
   * раньше. Внешний Promise.race, а не `timeout` у rss-parser: ему выставлены 15 с, и на замере
   * лента всё равно висела минутами — на этом обработчик и оборвался бы по потолку Vercel.
   */
  private async readFeed(
    feed: LiveFeed,
    deadline: number,
  ): Promise<{ feed: LiveFeed; items: ParsedRssItem[]; error: string | null }> {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      return { feed, items: [], error: 'бюджет прохода исчерпан до начала чтения' };
    }

    const timeoutMs = Math.min(this.feedTimeoutMs, remainingMs);
    let timer: NodeJS.Timeout | undefined;
    try {
      const items = await Promise.race([
        this.rss.fetchFeed(feed.feedUrl),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error(`не ответила за ${timeoutMs} мс`)), timeoutMs);
        }),
      ]);
      return { feed, items, error: null };
    } catch (error) {
      return { feed, items: [], error: describeError(error) };
    } finally {
      // Иначе оставшийся таймер держал бы процесс (и вызов на Vercel) открытым после ответа.
      if (timer) {
        clearTimeout(timer);
      }
    }
  }
}

function emptyOutcome(feedsTotal: number): LiveRssOutcome {
  return {
    feedsTotal,
    feedsOk: 0,
    feedsFailed: 0,
    itemsSeen: 0,
    finds: [],
    alreadyKnown: 0,
    undated: 0,
    elapsedMs: 0,
  };
}

function positiveInt(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

/** Node's fetch прячет настоящую причину в `error.cause` — см. collector-run.util.ts. */
function describeError(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }
  const cause = (error as Error & { cause?: unknown }).cause;
  if (cause instanceof Error && cause.message && cause.message !== error.message) {
    return `${error.message}: ${cause.message}`;
  }
  return error.message;
}
