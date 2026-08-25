import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

export enum MentionSourceType {
  NEWS = 'news',
  SOCIAL = 'social',
  TELEGRAM = 'telegram',
  REVIEWS = 'reviews',
  OTHER = 'other',
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

  @Column({ type: 'varchar', length: 64, unique: true })
  hash: string;

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
