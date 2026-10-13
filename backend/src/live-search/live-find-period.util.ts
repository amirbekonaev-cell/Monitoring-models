import { hasCurated, normalizeUrl } from '../curated/curated-mentions';
import { subtractCalendarDays, zonedDateString } from '../curated/curated-date.util';
import { ALL_TIME_PERIOD_DAYS } from '../curated/search-period.util';
import { LiveFind } from './live-find.types';

/**
 * Приводит набор находок к тому, что имеет право попасть в выдачу за период: выбрасывает
 * материалы вне окна, без даты, дубли по адресу и всё, что уже есть среди показываемых
 * материалов, — и сортирует от новых к старым.
 *
 * Материал без даты отбрасывается намеренно: поместить его в период нечем, а показать в выдаче
 * за «Неделю» материал неизвестного года — значит соврать про период, указанный в шапке.
 *
 * Функция чистая и вынесена из LiveSearchService потому, что фильтровать приходится ДВА РАЗА и в
 * разных вызовах вебхука: сразу после поиска (перед списком заголовков) и потом при развороте
 * статей по одному сообщению, когда находки читаются из хранилища (LiveFindStoreService). Окно
 * периода при втором чтении считается заново от текущего момента, поэтому находка, успевшая
 * выпасть из периода, в выдачу уже не попадёт.
 */
export function filterFindsToPeriod(
  finds: readonly LiveFind[],
  periodDays: number,
  now: Date,
  timezone: string,
): LiveFind[] {
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
