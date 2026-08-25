export interface Source {
  id: string;
  name: string | null;
  url: string;
  type: 'rss' | 'telegram' | 'parser' | 'search_api' | 'social_api' | 'social_search_api';
  status: 'active' | 'error' | 'disabled';
  lastSuccessAt: string | null;
  lastError: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  mentionsCount: number;
}

export interface AddSourceResponse {
  source: Source;
  type: Source['type'];
  ok: boolean;
  message: string;
  itemsFound?: number;
  itemsNew?: number;
  itemsFilteredByKeywords?: number;
}

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000';

export async function fetchSources(): Promise<Source[]> {
  const res = await fetch(`${API_URL}/sources`);
  if (!res.ok) throw new Error(`Не удалось загрузить источники: ${res.status}`);
  return res.json();
}

export async function addSource(url: string, name?: string): Promise<AddSourceResponse> {
  const res = await fetch(`${API_URL}/sources`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, name }),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.message ?? `Не удалось добавить источник: ${res.status}`);
  }
  return data;
}

export async function setSourceEnabled(id: string, enabled: boolean): Promise<void> {
  const res = await fetch(`${API_URL}/sources/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled }),
  });
  if (!res.ok) throw new Error(`Не удалось изменить источник: ${res.status}`);
}

export async function deleteSource(id: string): Promise<void> {
  const res = await fetch(`${API_URL}/sources/${id}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`Не удалось удалить источник: ${res.status}`);
}