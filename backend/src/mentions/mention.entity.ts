import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

export enum MentionSourceType {
  NEWS = 'news',
  SOCIAL = 'social',
  TELEGRAM = 'telegram',
  REVIEWS = 'reviews',
  OTHER = 'other',
  // К-6: найдено через OpenAI web search на Instagram/Facebook/Threads/публичных Telegram-каналах.
  SOCIAL_SEARCH = 'social_search',
}

export enum Sentiment {
  POSITIVE = 'positive',
  NEGATIVE = 'negative',
  NEUTRAL = 'neutral',
  UNDEFINED = 'undefined',
}

@Entity({ name: 'mentions' })
export class Mention {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'text' })
  title: string;

  @Column({ type: 'text', default: '' })
  text: string;

  @Column({ type: 'text' })
  url: string;

  @Index('IDX_mentions_published_at')
  @Column({ name: 'published_at', type: 'timestamptz', nullable: true })
  publishedAt: Date | null;

  @Column({ name: 'found_at', type: 'timestamptz', default: () => 'now()' })
  foundAt: Date;

  @Column({ name: 'source_id', type: 'uuid', nullable: true })
  sourceId: string | null;

  @Column({
    name: 'source_type',
    type: 'enum',
    enum: MentionSourceType,
    enumName: 'mention_source_type_enum',
    default: MentionSourceType.NEWS,
  })
  sourceType: MentionSourceType;

  @Column({ type: 'varchar', length: 2, nullable: true })
  language: string | null;

  @Column({ type: 'enum', enum: Sentiment, enumName: 'sentiment_enum', default: Sentiment.UNDEFINED })
  sentiment: Sentiment;

  @Column({ name: 'sentiment_manual', type: 'boolean', default: false })
  sentimentManual: boolean;

  /** Short (1-2 sentence) LLM-generated summary, produced by the same call that classifies sentiment. */
  @Column({ type: 'text', nullable: true })
  summary: string | null;

  @Column({ type: 'varchar', length: 64, unique: true })
  hash: string;

  /**
   * Явно указанный источник/платформа находки (например, "instagram.com", "kz-forum.example") —
   * заполняется каналами, у которых один запрос может вернуть результаты с разных площадок
   * (сейчас — только объединённый OpenAI web search, К-6). Для остальных каналов остаётся
   * null: там источник и так однозначен через source_id -> sources.name.
   */
  @Column({ name: 'source_label', type: 'text', nullable: true })
  sourceLabel: string | null;

  /** Set true the moment the Telegram alert has actually been claimed/sent — see MentionsService.claimForNotification. */
  @Column({ name: 'notification_sent', type: 'boolean', default: false })
  notificationSent: boolean;

  /** True for items found during a source's one-time historical catch-up run (not sent to Telegram individually). */
  @Column({ name: 'is_backfill', type: 'boolean', default: false })
  isBackfill: boolean;

  @Column({ type: 'jsonb', default: () => "'[]'" })
  keywords: string[];

  /** Reprints/duplicates of this mention found on other sources (deduplicated, not separate rows). */
  @Column({ type: 'jsonb', default: () => "'[]'" })
  reprints: MentionReprint[];

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}

export interface MentionReprint {
  url: string;
  sourceId: string | null;
  foundAt: string;
}