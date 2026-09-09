/**
 * Literal hex values for code that can't consume CSS custom properties (recharts fills/strokes).
 * Keep every value here identical to the matching `--sentiment-*`/`--color-*` variable in
 * ./tokens.css — the two are the single source of truth for the design system's colors and must
 * not drift apart.
 */

export const SENTIMENT_COLORS = {
  positive: '#1f7a5c',
  negative: '#a63a50',
  neutral: '#5b6472',
  undefined: '#9aa1ac',
} as const;

export const SENTIMENT_LABELS = {
  positive: 'Позитив',
  negative: 'Негатив',
  neutral: 'Нейтрал',
  undefined: 'Не определена',
} as const;

export const ACCENT_COLOR = '#2c4a86';
export const INK_MUTED_COLOR = '#5b6472';
export const BORDER_COLOR = '#dbe0e6';
