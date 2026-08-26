import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

export enum SourceKind {
  RSS = 'rss',
  TELEGRAM = 'telegram',
  PARSER = 'parser',
  SEARCH_API = 'search_api',
  SOCIAL_API = 'social_api',
  // К-6: соцсети/Telegram-каналы через OpenAI web search (не прямой API соцсети).
  SOCIAL_SEARCH_API = 'social_search_api',
}

export enum SourceStatus {
  ACTIVE = 'active',
  ERROR = 'error',
  DISABLED = 'disabled',
}

@Entity({ name: 'sources' })
export class Source {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  name: string | null;

  @Column({ type: 'text' })
  url: string;

  @Column({ type: 'enum', enum: SourceKind, enumName: 'source_type_enum' })
  type: SourceKind;

  @Column({ type: 'enum', enum: SourceStatus, enumName: 'source_status_enum', default: SourceStatus.ACTIVE })
  status: SourceStatus;

  @Column({ name: 'last_success_at', type: 'timestamptz', nullable: true })
  lastSuccessAt: Date | null;

  /** Last time this source went through the additional sitemap/HTML-pagination deep pass — see fetchRssWithDeepScan. */
  @Column({ name: 'last_deep_scan_at', type: 'timestamptz', nullable: true })
  lastDeepScanAt: Date | null;

  @Column({ name: 'last_error', type: 'text', nullable: true })
  lastError: string | null;

  @Column({ name: 'created_by', type: 'varchar', length: 255, nullable: true })
  createdBy: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}