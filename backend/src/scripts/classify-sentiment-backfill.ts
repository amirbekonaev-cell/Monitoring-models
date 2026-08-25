/**
 * One-off backfill: runs SentimentAnalysisService against every mention that doesn't have a
 * manual sentiment yet (sentiment_manual = false) and writes the result back — needed because
 * mentions collected before the sentiment feature existed (or before this script's first run)
 * never got classified.
 *
 * Also used as the data-generation step for the US-5 accuracy check (see
 * README "Тональность упоминаний — проверка точности (US-5)"): writes a JSON dump of
 * {id, title, text, url, sourceType, autoSentiment, autoReason} to the given output path so the
 * auto label can be compared against a manually-assigned ground truth afterwards.
 *
 * Usage: npm run classify-sentiment-backfill -- [outputJsonPath]
 * (from backend/, or via `docker compose exec backend ...` so it shares the real Postgres)
 */
import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import configuration from '../config/configuration';
import { Source } from '../sources/source.entity';
import { Mention, Sentiment } from '../mentions/mention.entity';
import { Keyword } from '../keywords/keyword.entity';
import { Setting } from '../settings/setting.entity';
import { ParserService } from '../collectors/parser/parser.service';
import { SentimentAnalysisService } from '../sentiment/sentiment-analysis.service';

// Deliberately does NOT import SentimentModule/ParserCollectorModule/AppModule: this brings in
// only ParserService + SentimentAnalysisService directly rather than the rest of the HTTP app.
// ParserService itself has no constructor dependencies, so it can be provided directly without
// its module.
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
    TypeOrmModule.forFeature([Mention]),
  ],
  providers: [ParserService, SentimentAnalysisService],
})
class ClassifySentimentBackfillModule {}

// Sequential with a small delay rather than parallel — this is a one-off maintenance run over
// however many rows are pending, not a live per-mention call; no need to race OpenAI's rate limit here.
const DELAY_BETWEEN_CALLS_MS = 200;

async function main(): Promise<void> {
  const outputPath = process.argv[2] ? path.resolve(process.argv[2]) : null;

  const app = await NestFactory.createApplicationContext(ClassifySentimentBackfillModule, {
    logger: ['log', 'warn', 'error'],
  });
  const sentimentService = app.get(SentimentAnalysisService);
  const mentionsRepo = app.get<Repository<Mention>>(getRepositoryToken(Mention));

  const pending = await mentionsRepo.find({
    where: { sentimentManual: false },
    order: { createdAt: 'ASC' },
  });
  console.log(`Найдено ${pending.length} упоминани(й) без ручной тональности — классифицирую...`);

  const results: Array<{
    id: string;
    title: string;
    text: string;
    url: string;
    sourceType: string;
    autoSentiment: Sentiment;
    autoReason: string | null;
  }> = [];

  let classified = 0;
  let failed = 0;

  for (const mention of pending) {
    try {
      const classification = await sentimentService.classify(mention.title, mention.text, mention.url);
      const sentiment = classification?.sentiment ?? Sentiment.UNDEFINED;
      await mentionsRepo
        .createQueryBuilder()
        .update(Mention)
        .set({ sentiment, sentimentManual: false, summary: classification?.summary ?? null })
        .where('id = :id AND sentiment_manual = false', { id: mention.id })
        .execute();

      results.push({
        id: mention.id,
        title: mention.title,
        text: mention.text,
        url: mention.url,
        sourceType: mention.sourceType,
        autoSentiment: sentiment,
        autoReason: classification?.reason ?? null,
      });
      classified += 1;
      console.log(`[${classified}/${pending.length}] ${mention.id} -> ${sentiment}`);
    } catch (error) {
      failed += 1;
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[${classified + failed}/${pending.length}] ${mention.id} FAILED: ${message}`);
      results.push({
        id: mention.id,
        title: mention.title,
        text: mention.text,
        url: mention.url,
        sourceType: mention.sourceType,
        autoSentiment: Sentiment.UNDEFINED,
        autoReason: `error: ${message}`,
      });
    }
    await new Promise((resolve) => setTimeout(resolve, DELAY_BETWEEN_CALLS_MS));
  }

  console.log(`Готово: классифицировано=${classified}, ошибок=${failed}, всего=${pending.length}`);

  if (outputPath) {
    fs.writeFileSync(outputPath, JSON.stringify(results, null, 2), 'utf-8');
    console.log(`Результаты сохранены: ${outputPath}`);
  }

  await app.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
