import { MigrationInterface, QueryRunner } from 'typeorm';

export class Settings1755900000000 implements MigrationInterface {
  name = 'Settings1755900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "settings" (
        "key" varchar(100) PRIMARY KEY,
        "value" text NOT NULL,
        "updated_at" timestamptz NOT NULL DEFAULT now()
      )
    `);
    // Default: collection is on. Stored in the DB (not just in-process memory) so the flag
    // survives a backend restart/redeploy — /pause must actually stay paused across that.
    await queryRunner.query(
      `INSERT INTO "settings" ("key", "value") VALUES ('collection_enabled', 'true') ON CONFLICT DO NOTHING`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "settings"`);
  }
}