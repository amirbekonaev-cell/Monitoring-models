import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * К-6: новый канал сбора (соцсети/Telegram через OpenAI web search) переиспользует
 * существующие таблицы sources/mentions — нужны только два новых значения enum.
 * ALTER TYPE ... ADD VALUE не используется в той же транзакции, что и вставка строк с этим
 * значением, поэтому безопасно выполняется внутри обычной транзакции миграции (PG12+).
 */
export class SocialSearch1756000000000 implements MigrationInterface {
  name = 'SocialSearch1756000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TYPE "source_type_enum" ADD VALUE IF NOT EXISTS 'social_search_api'`);
    await queryRunner.query(`ALTER TYPE "mention_source_type_enum" ADD VALUE IF NOT EXISTS 'social_search'`);
  }

  public async down(): Promise<void> {
    // Postgres has no DROP VALUE for enums — removing a value would require rebuilding the
    // type and every column/row referencing it. Left as a no-op, same trade-off as accepted
    // elsewhere in this project for additive enum changes.
  }
}