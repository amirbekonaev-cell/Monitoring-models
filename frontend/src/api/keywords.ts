import { apiRequest } from './client';
import { Keyword, KeywordType } from '../types/domain';

export async function fetchKeywords(): Promise<Keyword[]> {
  return apiRequest<Keyword[]>('/keywords', 'Не удалось загрузить ключевые слова');
}

export interface CreateKeywordInput {
  phrase: string;
  type: KeywordType;
  language: string;
  manualForms: string[];
}

export async function createKeyword(input: CreateKeywordInput): Promise<Keyword> {
  return apiRequest<Keyword>('/keywords', 'Не удалось добавить ключевое слово', {
    method: 'POST',
    body: input,
  });
}

export async function updateKeyword(id: string, patch: Partial<CreateKeywordInput & { isActive: boolean }>): Promise<Keyword> {
  return apiRequest<Keyword>(`/keywords/${id}`, 'Не удалось изменить ключевое слово', {
    method: 'PATCH',
    body: patch,
  });
}

export async function deleteKeyword(id: string): Promise<void> {
  await apiRequest<void>(`/keywords/${id}`, 'Не удалось удалить ключевое слово', { method: 'DELETE' });
}
