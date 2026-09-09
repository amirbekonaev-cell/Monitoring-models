import { apiRequest } from './client';
import { Mention, MentionsFilters, MentionsResponse, MentionsStats, Sentiment } from '../types/domain';

function filtersToQuery(filters: MentionsFilters): Record<string, string | undefined> {
  return {
    period: filters.period === 'custom' ? undefined : filters.period,
    dateFrom: filters.period === 'custom' ? filters.dateFrom : undefined,
    dateTo: filters.period === 'custom' ? filters.dateTo : undefined,
    sentiment: filters.sentiment,
    sourceId: filters.sourceId,
    sourceType: filters.sourceType,
    language: filters.language,
    search: filters.search,
  };
}

export async function fetchMentions(filters: MentionsFilters, limit: number, offset: number): Promise<MentionsResponse> {
  return apiRequest<MentionsResponse>('/mentions', 'Не удалось загрузить упоминания', {
    query: { ...filtersToQuery(filters), limit, offset },
  });
}

export async function fetchMentionStats(filters: MentionsFilters): Promise<MentionsStats> {
  return apiRequest<MentionsStats>('/mentions/stats', 'Не удалось загрузить статистику', {
    query: filtersToQuery(filters),
  });
}

export async function updateMentionSentiment(id: string, sentiment: Sentiment): Promise<Mention> {
  return apiRequest<Mention>(`/mentions/${id}/sentiment`, 'Не удалось изменить тональность', {
    method: 'PATCH',
    body: { sentiment },
  });
}
