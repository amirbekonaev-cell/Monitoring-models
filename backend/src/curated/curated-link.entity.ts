import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

/**
 * Plain string values, not a PG enum (see the CuratedLinks migration) — the ingestion script
 * (ПРОМПТ 2) owns transitions between these; CuratedSearchService (this prompt) only reads them.
 */
export enum CuratedLinkStatus {
  PENDING = 'pending',
  PROCESSED = 'processed',
  NOT_RELEVANT = 'not_relevant',
  FAILED = 'failed',
  EXCLUDED = 'excluded',
}

/** How a processed link's publish date was determined — set by ПРОМПТ 2's ingestion script. */
export type CuratedLinkDateSource = 'page' | 'url' | 'model';

@Entity({ name: 'curated_links' })
export class CuratedLink {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'text' })
  url: string;

  /** sha256 of the normalized URL — the dedup key for the closed pool. */
  @Column({ name: 'url_hash', type: 'varchar', length: 64, unique: true })
  urlHash: string;

  @Column({ type: 'varchar', nullable: true })
  host: string | null;

  @Column({ name: 'group_label', type: 'varchar', nullable: true })
  groupLabel: string | null;

  @Column({ type: 'varchar', default: CuratedLinkStatus.PENDING })
  status: CuratedLinkStatus;

  @Column({ type: 'int', default: 0 })
  attempts: number;

  @Column({ name: 'last_error', type: 'text', nullable: true })
  lastError: string | null;

  @Column({ name: 'date_source', type: 'varchar', length: 16, nullable: true })
  dateSource: CuratedLinkDateSource | null;

  /** The mention this link produced, once processed — set by ПРОМПТ 2. */
  @Column({ name: 'mention_id', type: 'uuid', nullable: true })
  mentionId: string | null;

  @Column({ name: 'last_attempt_at', type: 'timestamptz', nullable: true })
  lastAttemptAt: Date | null;

  @Column({ name: 'processed_at', type: 'timestamptz', nullable: true })
  processedAt: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
