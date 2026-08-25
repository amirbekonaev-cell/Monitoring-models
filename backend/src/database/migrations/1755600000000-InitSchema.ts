import { MigrationInterface, QueryRunner } from 'typeorm';

export class InitSchema1755600000000 implements MigrationInterface {
  name = 'InitSchema1755600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`);
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "pg_trgm"`);

    await queryRunner.query(`
      CREATE TYPE "source_type_enum" AS ENUM ('rss', 'telegram', 'parser', 'search_api', 'social_api')
    `);
    await queryRunner.query(`
      CREATE TYPE "source_status_enum" AS ENUM ('active', 'error', 'disabled')
    `);
    await queryRunner.query(`
      CREATE TYPE "mention_source_type_enum" AS ENUM ('news', 'social', 'telegram', 'reviews', 'other')
    `);
    await queryRunner.query(`
      CREATE TYPE "sentiment_enum" AS ENUM ('positive', 'negative', 'neutral', 'undefined')
    `);
    await queryRunner.query(`
      CREATE TYPE "keyword_type_enum" AS ENUM ('required', 'minus', 'exact_phrase')
    `);

    await queryRunner.query(`
      CREATE TABLE "sources" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "name" varchar(255),
        "url" text NOT NULL,
        "type" "source_type_enum" NOT NULL,
        "status" "source_status_enum" NOT NULL DEFAULT 'active',
        "last_success_at" timestamptz,
        "last_error" text,
        "created_by" varchar(255),
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_sources_url" UNIQUE ("url")
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "mentions" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "title" text NOT NULL,
        "text" text NOT NULL DEFAULT '',
        "url" text NOT NULL,
        "published_at" timestamptz,
        "found_at" timestamptz NOT NULL DEFAULT now(),
        "source_id" uuid REFERENCES "sources"("id") ON DELETE SET NULL,
        "source_type" "mention_source_type_enum" NOT NULL DEFAULT 'news',
        "language" varchar(2),
        "sentiment" "sentiment_enum" NOT NULL DEFAULT 'undefined',
        "sentiment_manual" boolean NOT NULL DEFAULT false,
        "hash" varchar(64) NOT NULL,
        "keywords" jsonb NOT NULL DEFAULT '[]',
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_mentions_hash" UNIQUE ("hash")
      )
    `);

    await queryRunner.query(`
      ALTER TABLE "mentions" ADD COLUMN "search_vector" tsvector
      GENERATED ALWAYS AS (to_tsvector('russian', coalesce("title", '') || ' ' || coalesce("text", ''))) STORED
    `);
    await queryRunner.query(`CREATE INDEX "IDX_mentions_search_vector" ON "mentions" USING GIN ("search_vector")`);
    await queryRunner.query(`CREATE INDEX "IDX_mentions_published_at" ON "mentions" ("published_at")`);
    await queryRunner.query(`CREATE INDEX "IDX_mentions_found_at" ON "mentions" ("found_at")`);
    await queryRunner.query(`CREATE INDEX "IDX_mentions_source_id" ON "mentions" ("source_id")`);
    await queryRunner.query(`CREATE INDEX "IDX_mentions_sentiment" ON "mentions" ("sentiment")`);
    await queryRunner.query(`CREATE INDEX "IDX_mentions_title_trgm" ON "mentions" USING GIN ("title" gin_trgm_ops)`);

    await queryRunner.query(`
      CREATE TABLE "keywords" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "phrase" text NOT NULL,
        "type" "keyword_type_enum" NOT NULL DEFAULT 'required',
        "is_active" boolean NOT NULL DEFAULT true,
        "created_at" timestamptz NOT NULL DEFAULT now()
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "keywords"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "mentions"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "sources"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "keyword_type_enum"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "sentiment_enum"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "mention_source_type_enum"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "source_status_enum"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "source_type_enum"`);
  }
}
