import { MigrationInterface, QueryRunner } from 'typeorm';

export class Week341755700000000 implements MigrationInterface {
  name = 'Week341755700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "keywords" ADD COLUMN "language" varchar(2) NOT NULL DEFAULT 'ru'`);
    await queryRunner.query(`ALTER TABLE "keywords" ADD COLUMN "manual_forms" jsonb NOT NULL DEFAULT '[]'`);
    await queryRunner.query(`ALTER TABLE "mentions" ADD COLUMN "reprints" jsonb NOT NULL DEFAULT '[]'`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "mentions" DROP COLUMN IF EXISTS "reprints"`);
    await queryRunner.query(`ALTER TABLE "keywords" DROP COLUMN IF EXISTS "manual_forms"`);
    await queryRunner.query(`ALTER TABLE "keywords" DROP COLUMN IF EXISTS "language"`);
  }
}