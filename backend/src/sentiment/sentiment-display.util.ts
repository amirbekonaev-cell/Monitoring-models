import { Sentiment } from '../mentions/mention.entity';

/**
 * Single source of truth for how a Sentiment value is shown to a human on the backend side
 * (currently: Telegram /search summaries). Mirrors the color scheme used on the dashboard
 * (frontend/src/components/MentionsList.tsx SENTIMENT_COLOR) — positive=green, negative=red,
 * neutral=yellow, undefined=grey — so the two surfaces stay semantically in sync without sharing
 * actual code across the frontend/backend boundary.
 */
export const SENTIMENT_DISPLAY: Record<Sentiment, { emoji: string; label: string }> = {
  [Sentiment.POSITIVE]: { emoji: '🟢', label: 'Позитив' },
  [Sentiment.NEGATIVE]: { emoji: '🔴', label: 'Негатив' },
  [Sentiment.NEUTRAL]: { emoji: '🟡', label: 'Нейтрал' },
  [Sentiment.UNDEFINED]: { emoji: '⚪', label: 'Не определена' },
};

export function formatSentiment(sentiment: Sentiment): string {
  const display = SENTIMENT_DISPLAY[sentiment] ?? SENTIMENT_DISPLAY[Sentiment.UNDEFINED];
  return `${display.emoji} ${display.label}`;
}
