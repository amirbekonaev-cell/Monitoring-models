import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Consolidating K-6 (social search) into a single unrestricted OpenAI web search query means we
 * no longer have one Source row per platform to attribute a result to — the source/domain is
 * only known per-item, from the citation URL actually returned. This column carries that
 * explicit source label on the mention itself so it survives independently of source_id.
 */
export class MentionSourceLabel1756100000000 implements MigrationInterface {
  name = 'MentionSourceLabel1756100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "mentions" ADD COLUMN IF NOT EXISTS "source_label" text`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "mentions" DROP COLUMN IF EXISTS "source_label"`);
  }
}