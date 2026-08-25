import { MigrationInterface, QueryRunner } from 'typeorm';

export class TelegramNotify1755800000000 implements MigrationInterface {
  name = 'TelegramNotify1755800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "mentions" ADD COLUMN "notification_sent" boolean NOT NULL DEFAULT false`);
    await queryRunner.query(`ALTER TABLE "mentions" ADD COLUMN "is_backfill" boolean NOT NULL DEFAULT false`);
    // Partial index: the notifier only ever queries/updates rows still pending a send.
    await queryRunner.query(
      `CREATE INDEX "IDX_mentions_notification_pending" ON "mentions" ("notification_sent") WHERE "notification_sent" = false`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_mentions_notification_pending"`);
    await queryRunner.query(`ALTER TABLE "mentions" DROP COLUMN IF EXISTS "is_backfill"`);
    await queryRunner.query(`ALTER TABLE "mentions" DROP COLUMN IF EXISTS "notification_sent"`);
  }
}