import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * RSS feeds only ever expose their last N items — see CLAUDE.md task on RSS backfill depth.
 * `last_deep_scan_at` tracks when a source last went through the additional sitemap/HTML-pagination
 * deep pass (ParserService.deepCollect, orchestrated by fetchRssWithDeepScan), separately from
 * `last_success_at` (which tracks the fast RSS/parser fetch itself) — so that deep pass can be
 * throttled (RSS_DEEP_SCAN_INTERVAL_HOURS) instead of re-walking the whole sitemap on every /search.
 */
export class SourceDeepScan1756300000000 implements MigrationInterface {
  name = 'SourceDeepScan1756300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "sources" ADD COLUMN IF NOT EXISTS "last_deep_scan_at" timestamptz`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "sources" DROP COLUMN IF EXISTS "last_deep_scan_at"`);
  }
}
