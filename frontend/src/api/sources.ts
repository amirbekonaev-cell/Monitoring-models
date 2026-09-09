import { apiRequest } from './client';
import { AddSourceResponse, Source } from '../types/domain';

export async function fetchSources(): Promise<Source[]> {
  return apiRequest<Source[]>('/sources', 'Не удалось загрузить источники');
}

export async function addSource(url: string, name?: string): Promise<AddSourceResponse> {
  return apiRequest<AddSourceResponse>('/sources', 'Не удалось добавить источник', {
    method: 'POST',
    body: { url, name },
  });
}

export async function setSourceEnabled(id: string, enabled: boolean): Promise<void> {
  await apiRequest<Source>(`/sources/${id}`, 'Не удалось изменить источник', {
    method: 'PATCH',
    body: { enabled },
  });
}

export async function deleteSource(id: string): Promise<void> {
  await apiRequest<{ ok: boolean }>(`/sources/${id}`, 'Не удалось удалить источник', { method: 'DELETE' });
}
