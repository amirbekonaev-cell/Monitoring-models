import { createHash } from 'crypto';

export function hashMentionText(title: string, text: string): string {
  const normalized = `${title.trim().toLowerCase()}|${text.trim().toLowerCase()}`;
  return createHash('sha256').update(normalized).digest('hex');
}
