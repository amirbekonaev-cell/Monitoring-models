import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The same OpenAI call that classifies sentiment also returns a short (1-2 sentence) neutral-tone
 * summary of the material — this column stores it so it can be shown in the Telegram alert and the
 * mention card without a separate "summarize" call.
 */
export class MentionSummary1756200000000 implements MigrationInterface {
  name = 'MentionSummary1756200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "mentions" ADD COLUMN IF NOT EXISTS "summary" text`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "mentions" DROP COLUMN IF EXISTS "summary"`);
  }
}
