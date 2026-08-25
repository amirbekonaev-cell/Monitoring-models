export type KeywordType = 'required' | 'minus' | 'exact_phrase';

export interface Keyword {
  id: string;
  phrase: string;
  type: KeywordType;
  isActive: boolean;
  language: string;
  manualForms: string[];
  createdAt: string;
}

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000';

export async function fetchKeywords(): Promise<Keyword[]> {
  const res = await fetch(`${API_URL}/keywords`);
  if (!res.ok) throw new Error(`Не удалось загрузить ключевые слова: ${res.status}`);
  return res.json();
}

export interface CreateKeywordInput {
  phrase: string;
  type: KeywordType;
  language: string;
  manualForms: string[];
}

export async function createKeyword(input: CreateKeywordInput): Promise<Keyword> {
  const res = await fetch(`${API_URL}/keywords`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(`Не удалось добавить ключевое слово: ${res.status}`);
  return res.json();
}

export async function updateKeyword(id: string, patch: Partial<CreateKeywordInput & { isActive: boolean }>): Promise<Keyword> {
  const res = await fetch(`${API_URL}/keywords/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`Не удалось изменить ключевое слово: ${res.status}`);
  return res.json();
}

export async function deleteKeyword(id: string): Promise<void> {
  const res = await fetch(`${API_URL}/keywords/${id}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`Не удалось удалить ключевое слово: ${res.status}`);
}
