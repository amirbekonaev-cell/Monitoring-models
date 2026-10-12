import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { hasCurated, normalizeUrl } from '../curated/curated-mentions';
import { zonedDateString, subtractCalendarDays } from '../curated/curated-date.util';
import { ALL_TIME_PERIOD_DAYS } from '../curated/search-period.util';
import { parseBrandForms } from './brand-match.util';
import { LiveRssSearchService } from './live-rss-search.service';
import { OpenAiNewsSearchService } from './openai-news-search.service';
import { LiveFind } from './live-find.types';

/** Потолок на весь живой поиск. Лежит внутри паузы выдачи, так что /search от него не длиннее. */
const DEFAULT_BUDGET_MS = 27000;

export interface LiveSearchOutcome {
  /** Находки за период, уже без дублей и без того, что и так есть в выдаче. */
  finds: LiveFind[];
  /** Сколько каналов отработало и сколько из них упало — только для логов. */
  channelsOk: number;
  channelsFailed: number;
  elapsedMs: number;
}

/**
 * Живой поиск: оба канала сразу и параллельно — RSS-ленты изданий и веб-поиск по открытому
 * интернету. Запускается в обработчике /search и идёт ВНУТРИ паузы выдачи, поэтому к длительности
 * ответа не добавляет ничего.
 *
 * Почему два канала, а не один. Они отвечают на разные вопросы и ошибаются по-разному:
 *  - **ленты** дают сегодняшнее: 17 лент параллельно за 3.2 с, 1760 материалов, даты у всех. Но
 *    лента хранит лишь последние 10–100 записей, поэтому прошлое по ней не найти;
 *  - **веб-поиск** достаёт как раз прошлое и, главное, издания, которых мы не знаем: в замерах
 *    пришли tengrinews, forbes.kz, osn.kz, btw.media. Зато он платный, медленнее (16–21 с) и
 *    непостоянен — три прогона подряд дали разные пересекающиеся наборы.
 * Вместе они перекрывают слабые места друг друга, и падение любого из них не лишает выдачу
 * второго: каналы изолированы друг от друга так же, как ленты внутри прохода по лентам.
 *
 * Результат склеивается с материалами, которые бот показывает и так: одинаковые адреса
 * выбрасываются (`normalizeUrl` + `hasCurated`), остальное сортируется по дате и уходит в выдачу
 * теми же функциями, что и всё прочее. Для человека это один список результатов поиска.
 */
@Injectable()
export class LiveSearchService {
  private readonly logger = new Logger(LiveSearchService.name);

  constructor(
    private readonly rssSearch: LiveRssSearchService,
    private readonly openAiSearch: OpenAiNewsSearchService,
    private readonly config: ConfigService,
  ) {}

  private get budgetMs(): number {
    const value = this.config.get<number>('liveSearch.budgetMs');
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_BUDGET_MS;
  }

  private get timezone(): string {
    return this.config.get<string>('curated.timezone') || 'Asia/Almaty';
  }

  /**
   * Один живой поиск за период. Никогда не бросает: оба канала обёрнуты, и любой их сбой
   * превращается в предупреждение в логе и пустой вклад этого канала — выдача обязана уйти
   * человеку независимо от того, что случилось с сетью.
   */
  async collect(periodDays: number, now: Date = new Date()): Promise<LiveSearchOutcome> {
    const startedAt = Date.now();
    const deadline = startedAt + this.budgetMs;
    const brandForms = parseBrandForms(this.config.get<string>('liveSearch.brandForms'));

    const [rssResult, openAiResult] = await Promise.all([
      this.rssSearch
        .collect(periodDays, now)
        .then((outcome) => ({ finds: outcome.finds, failed: false }))
        .catch((error) => {
          this.logger.warn(`Канал «RSS-ленты» не отработал: ${describeError(error)}`);
          return { finds: [] as LiveFind[], failed: true };
        }),
      this.openAiSearch
        .search(brandForms, deadline)
        .then((finds) => ({ finds, failed: false }))
        .catch((error) => {
          this.logger.warn(`Канал «веб-поиск» не отработал: ${describeError(error)}`);
          return { finds: [] as LiveFind[], failed: true };
        }),
    ]);

    // Ленты первыми: у них дата из самого фида, а не восстановленная моделью, поэтому при
    // совпадении адресов остаётся запись ленты.
    const finds = this.mergeAndFilter([...rssResult.finds, ...openAiResult.finds], periodDays, now);

    const channelsFailed = Number(rssResult.failed) + Number(openAiResult.failed);
    const outcome: LiveSearchOutcome = {
      finds,
      channelsOk: 2 - channelsFailed,
      channelsFailed,
      elapsedMs: Date.now() - startedAt,
    };

    this.logger.log(
      `Живой поиск: ленты ${rssResult.finds.length}, веб-поиск ${openAiResult.finds.length}, ` +
        `после склейки и фильтра по периоду ${finds.length}; каналов отработало ` +
        `${outcome.channelsOk}/2, ${outcome.elapsedMs} мс`,
    );

    return outcome;
  }

  /**
   * Склейка: выбрасывает материалы вне периода, без даты, дубли по адресу и всё, что уже есть
   * среди показываемых материалов, — и сортирует от новых к старым.
   *
   * Материал без даты отбрасывается намеренно: поместить его в период нечем, а показать в выдаче
   * за «Неделю» материал неизвестного года — значит соврать про период, указанный в шапке.
   */
  private mergeAndFilter(finds: LiveFind[], periodDays: number, now: Date): LiveFind[] {
    const timezone = this.timezone;
    const dateTo = zonedDateString(now, timezone);
    const dateFrom = periodDays >= ALL_TIME_PERIOD_DAYS ? null : subtractCalendarDays(dateTo, periodDays);

    const seen = new Set<string>();
    const kept: LiveFind[] = [];

    for (const find of finds) {
      if (!find.publishedAt || Number.isNaN(find.publishedAt.getTime())) {
        continue;
      }
      const day = zonedDateString(find.publishedAt, timezone);
      if ((dateFrom !== null && day < dateFrom) || day > dateTo) {
        continue;
      }
      const key = normalizeUrl(find.url);
      if (seen.has(key) || hasCurated(find.url)) {
        continue;
      }
      seen.add(key);
      kept.push(find);
    }

    return kept.sort((a, b) => (b.publishedAt as Date).getTime() - (a.publishedAt as Date).getTime());
  }
}

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
