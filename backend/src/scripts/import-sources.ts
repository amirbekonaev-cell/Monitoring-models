/**
 * Bulk-imports sources from docs/sources.txt (one URL per line, "#" lines/blank lines ignored),
 * reusing the exact same add-by-link + auto-detect + immediate-test-collection logic as the
 * "Добавить по ссылке" form (SourceOnboardingService) — nothing is duplicated here.
 *
 * Safe to re-run: URLs already present in `sources` are reported and skipped, so this is the
 * same command to use later when Telegram-channel or social lines get appended to the file.
 *
 * Usage: npm run import-sources   (from backend/, or via `docker compose run --rm migrate ...`
 * so it shares the real Postgres — plain host runs won't resolve the `postgres` hostname from .env)
 */
import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import configuration from '../config/configuration';
import { Source } from '../sources/source.entity';
import { Mention } from '../mentions/mention.entity';
import { Keyword } from '../keywords/keyword.entity';
import { Setting } from '../settings/setting.entity';
import { SourceOnboardingModule } from '../sources/onboarding/source-onboarding.module';
import { SourceOnboardingService } from '../sources/onboarding/source-onboarding.service';

// Deliberately does NOT import AppModule: this brings in only what SourceOnboardingService needs,
// not the rest of the HTTP app (controllers, the Telegram bot, etc.) that a one-off CLI import has
// no use for.
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [configuration] }),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres',
        host: config.get<string>('db.host'),
        port: config.get<number>('db.port'),
        username: config.get<string>('db.username'),
        password: config.get<string>('db.password'),
        database: config.get<string>('db.database'),
        ssl: config.get('db.ssl'),
        entities: [Source, Mention, Keyword, Setting],
        synchronize: false,
      }),
    }),
    SourceOnboardingModule,
  ],
})
class ImportSourcesModule {}

function readSourceUrls(filePath: string): string[] {
  return fs
    .readFileSync(filePath, 'utf-8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

async function main(): Promise<void> {
  const filePath = process.env.SOURCES_FILE
    ? path.resolve(process.env.SOURCES_FILE)
    : path.resolve(__dirname, '../../docs/sources.txt');

  if (!fs.existsSync(filePath)) {
    console.error(`Файл со списком источников не найден: ${filePath}`);
    process.exit(1);
  }

  const urls = readSourceUrls(filePath);
  console.log(`Импортирую ${urls.length} источник(ов) из ${filePath}`);

  const app = await NestFactory.createApplicationContext(ImportSourcesModule, {
    logger: ['log', 'warn', 'error'],
  });
  const onboarding = app.get(SourceOnboardingService);

  for (const url of urls) {
    try {
      const result = await onboarding.addByLink(url, null, 'import-script');
      if (result.ok) {
        console.log(
          `OK    ${url} -> тип=${result.type}, найдено=${result.itemsFound}, новых=${result.itemsNew}, ` +
            `отфильтровано ключевыми словами=${result.itemsFilteredByKeywords}` +
            (result.deepScanNote ? ` (${result.deepScanNote})` : ''),
        );
      } else {
        console.log(`ERROR ${url} -> тип=${result.type}, причина: ${result.message}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(`SKIP  ${url} -> ${message}`);
    }
  }

  await app.close();
}

main().catch((error) => {
  console.error('Импорт источников не удался:', error);
  process.exit(1);
});