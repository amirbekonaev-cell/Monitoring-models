/**
 * Shared Nest bootstrap for the closed-pool CLI scripts (`curated:import`, `curated:process`,
 * `curated:status`, `curated:leak-check`).
 *
 * Built the same way as classify-sentiment-backfill.ts: an application context wiring up only
 * the services these scripts need, never AppModule — the scripts must not start an HTTP server,
 * a Telegram webhook or any scheduler just to touch the database. Pool administration is
 * CLI-only by design (there is no HTTP endpoint that exposes `curated_links`, see
 * curated.module.ts), so this is the one place the pool can be written from.
 *
 * Works unchanged against a local compose Postgres (DB_HOST/DB_PORT/...) and against the
 * deployment's managed database (DATABASE_URL) — resolveDbConfig() picks between them, so which
 * database a script touches is decided purely by the environment it is run with.
 */
import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { INestApplicationContext } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import configuration from '../config/configuration';
import { Source } from '../sources/source.entity';
import { Mention } from '../mentions/mention.entity';
import { Keyword } from '../keywords/keyword.entity';
import { Setting } from '../settings/setting.entity';
import { CuratedLink } from '../curated/curated-link.entity';
import { CuratedModule } from '../curated/curated.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
      // Both env files, backend/.env first. The repo root's .env is where the shared settings
      // live (OPENAI_API_KEY, EXCLUDED_DOMAINS, SEARCH_*) — docker-compose passes it to the
      // backend service via env_file, but a script run straight from backend/ would otherwise
      // only see backend/.env and come up without a key. Earlier files win, and neither
      // overrides a variable already set in the environment, so an inline
      // `DB_HOST=... npm run ...` still takes precedence over both.
      envFilePath: ['.env', '../.env'],
    }),
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
        entities: [Source, Mention, Keyword, Setting, CuratedLink],
        synchronize: false,
      }),
    }),
    CuratedModule,
  ],
})
export class CuratedScriptModule {}

export function createCuratedScriptContext(): Promise<INestApplicationContext> {
  return NestFactory.createApplicationContext(CuratedScriptModule, { logger: ['log', 'warn', 'error'] });
}

/** Names the database a script is about to touch — host and database name, never the password. */
export function describeDatabase(): string {
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl) {
    const parsed = new URL(databaseUrl);
    return `DATABASE_URL -> ${parsed.hostname}/${parsed.pathname.replace(/^\//, '')}`;
  }
  return `DB_HOST -> ${process.env.DB_HOST || 'localhost'}:${process.env.DB_PORT || '5432'}/${process.env.DB_NAME || 'mentions'}`;
}

/** `--flag` presence in argv. */
export function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

/**
 * The value of `--name value` or `--name=value`, or undefined when the flag is absent.
 *
 * The `index === -1` guard is load-bearing: without it `argv[indexOf(...) + 1]` silently reads
 * `argv[0]` — the node executable's own path — for every flag that was NOT passed.
 */
function flagValue(name: string): string | undefined {
  const argv = process.argv;
  const inline = argv.find((a) => a.startsWith(`--${name}=`));
  if (inline) {
    return inline.slice(`--${name}=`.length);
  }
  const index = argv.indexOf(`--${name}`);
  if (index === -1) {
    return undefined;
  }
  const next = argv[index + 1];
  // A following token that is itself a flag means this one was used as a bare switch.
  return next && !next.startsWith('--') ? next : undefined;
}

/** `--name value` or `--name=value`, parsed as a positive integer; undefined when absent/invalid. */
export function numberFlag(name: string): number | undefined {
  const parsed = parseInt(flagValue(name) ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/** `--name a,b,c` or `--name=a,b,c`, parsed as a comma-separated list; undefined when absent. */
export function listFlag(name: string): string[] | undefined {
  const values = (flagValue(name) ?? '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
  return values.length > 0 ? values : undefined;
}
