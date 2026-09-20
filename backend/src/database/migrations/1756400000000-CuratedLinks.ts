import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Closed-pool Telegram bot (ПРОМПТ 1/2): /search and /status stop polling live channels
 * entirely and instead read from a curated, pre-vetted list of article links processed
 * out-of-band (ПРОМПТ 2's script). `curated_links` tracks that pool and its processing state;
 * `mentions.curated_link_id` ties a produced mention back to the link that generated it.
 *
 * `status` is a plain varchar, not a PG enum — the closed pool's processing states (pending/
 * processed/not_relevant/failed/excluded) are churned by an external script (ПРОМПТ 2), and a
 * varchar avoids the ALTER TYPE ADD VALUE ceremony (and its lack of a DROP VALUE) for a column
 * that's likely to grow another status before this project is done.
 *
 * `mentions.url_hidden` is a column of its own (not derived from `curated_link_id IS NOT NULL`)
 * on purpose: deleting a `curated_links` row (SET NULL on the FK) must never make a mention's URL
 * eligible to be shown again — the flag is the durable "never show this URL" record, independent
 * of whether the curated_links row that originally caused it still exists.
 */
export class CuratedLinks1756400000000 implements MigrationInterface {
  name = 'CuratedLinks1756400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TYPE "source_type_enum" ADD VALUE IF NOT EXISTS 'curated'`);

    await queryRunner.query(`
      CREATE TABLE "curated_links" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "url" text NOT NULL,
        "url_hash" varchar(64) NOT NULL,
        "host" varchar,
        "group_label" varchar,
        "status" varchar NOT NULL DEFAULT 'pending',
        "attempts" int NOT NULL DEFAULT 0,
        "last_error" text,
        "date_source" varchar(16),
        "mention_id" uuid REFERENCES "mentions"("id") ON DELETE SET NULL,
        "last_attempt_at" timestamptz,
        "processed_at" timestamptz,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_curated_links_url_hash" UNIQUE ("url_hash")
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_curated_links_status" ON "curated_links" ("status")`);

    await queryRunner.query(`ALTER TABLE "mentions" ADD COLUMN IF NOT EXISTS "url_hidden" boolean NOT NULL DEFAULT false`);
    await queryRunner.query(`
      ALTER TABLE "mentions" ADD COLUMN IF NOT EXISTS "curated_link_id" uuid
      REFERENCES "curated_links"("id") ON DELETE SET NULL
    `);
    // Partial (not plain UNIQUE): most mentions have curated_link_id = NULL (every mention from
    // the pre-existing channels), and a plain unique index would only allow ONE such row total.
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_mentions_curated_link_id" ON "mentions" ("curated_link_id")
      WHERE "curated_link_id" IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_mentions_curated_link_id"`);
    await queryRunner.query(`ALTER TABLE "mentions" DROP COLUMN IF EXISTS "curated_link_id"`);
    await queryRunner.query(`ALTER TABLE "mentions" DROP COLUMN IF EXISTS "url_hidden"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_curated_links_status"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "curated_links"`);
    // Postgres has no DROP VALUE for enums — same accepted trade-off as SocialSearch1756000000000.
  }
}
