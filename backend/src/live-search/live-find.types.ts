import { Sentiment } from '../mentions/mention.entity';
import { CuratedMentionView } from '../curated/curated-search.types';

/**
 * Материал, найденный живым поиском — лентами или веб-поиском.
 *
 * Пересказ и тональность необязательны: веб-поиск отдаёт их в том же вызове (см.
 * OpenAiNewsSearchService), а лента — только заголовок с датой, и выдумывать за неё тональность
 * никто не вправе.
 */
export interface LiveFind {
  title: string;
  url: string;
  publishedAt: Date | null;
  sourceName: string;
  domain: string;
  summary: string | null;
  sentiment: Sentiment;
}

/**
 * Находка в том же виде, в каком выдача показывает любой другой материал.
 *
 * Весь смысл приведения — в том, что дальше находку рисуют те же самые функции
 * (buildTitleListMessages, buildItemBlock), которыми рисуется всё остальное. Отдельного формата
 * «для найденного только что» не существует: человек, читающий сообщение, видит один список
 * результатов поиска, а не два разных по происхождению.
 */
export function liveFindToMentionView(find: LiveFind): CuratedMentionView {
  return {
    // Префикс, чтобы идентификатор находки не столкнулся с идентификатором материала набора
    // ("1.1", "12.3") — они живут в одном списке.
    id: `live:${find.domain}:${find.url}`,
    title: find.title,
    sourceLabel: find.sourceName,
    publishedAt: find.publishedAt,
    sentiment: find.sentiment,
    summary: find.summary,
    snippet: null,
    url: find.url,
  };
}
