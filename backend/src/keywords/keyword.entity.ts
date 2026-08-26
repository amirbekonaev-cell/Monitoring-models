import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

export enum KeywordType {
  REQUIRED = 'required',
  MINUS = 'minus',
  EXACT_PHRASE = 'exact_phrase',
}

@Entity({ name: 'keywords' })
export class Keyword {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'text' })
  phrase: string;

  @Column({ type: 'enum', enum: KeywordType, enumName: 'keyword_type_enum', default: KeywordType.REQUIRED })
  type: KeywordType;

  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive: boolean;

  /** 'ru' | 'kk' | 'en' — which morphology strategy to use for matching. */
  @Column({ type: 'varchar', length: 2, default: 'ru' })
  language: string;

  /**
   * Manual word forms, used as a fallback when automatic morphology is unreliable
   * (mainly Kazakh, since Postgres has no built-in 'kazakh' text search config).
   */
  @Column({ name: 'manual_forms', type: 'jsonb', default: () => "'[]'" })
  manualForms: string[];

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}