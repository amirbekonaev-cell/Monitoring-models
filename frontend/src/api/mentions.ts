export interface Mention {
  id: string;
  title: string;
  text: string;
  url: string;
  publishedAt: string | null;
  foundAt: string;
  sourceId: string | null;
  sourceType: string;
  language: string | null;
  sentiment: string;
  sentimentManual: boolean;
}

export interface MentionsResponse {
  items: Mention[];
  total: number;
  limit: number;
  offset: number;
}

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000';

export async function fetchMentions(): Promise<MentionsResponse> {
  const res = await fetch(`${API_URL}/mentions?limit=50`);
  if (!res.ok) {
    throw new Error(`Failed to load mentions: ${res.status}`);
  }
  return res.json();
}