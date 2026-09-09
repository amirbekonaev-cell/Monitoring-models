import { MentionSourceType, SourceKind } from '../types/domain';

export const MENTION_SOURCE_TYPE_LABELS: Record<MentionSourceType, string> = {
  news: 'Новости',
  social: 'Соцсети',
  telegram: 'Telegram',
  reviews: 'Отзывы',
  other: 'Другое',
  social_search: 'Веб-поиск',
};

export const SOURCE_KIND_LABELS: Record<SourceKind, string> = {
  rss: 'RSS (К-2)',
  telegram: 'Telegram (К-3)',
  parser: 'Универсальный парсер (К-5)',
  search_api: 'Поисковый API (К-1)',
  social_api: 'Соцсеть VK (К-4)',
  social_search_api: 'Соцсети через OpenAI web search (К-6)',
};

export const LANGUAGE_LABELS: Record<string, string> = {
  ru: 'Русский',
  kk: 'Казахский',
  en: 'Английский',
};
