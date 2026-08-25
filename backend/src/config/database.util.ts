export interface ResolvedDbConfig {
  host: string;
  port: number;
  username: string;
  password: string;
  database: string;
  ssl: { rejectUnauthorized: false } | false;
}

/**
 * DATABASE_URL (Neon/Supabase style, e.g. postgres://user:pass@host/db?sslmode=require) wins when
 * set — this is what a serverless deploy (Vercel) uses, since there's no local `postgres` compose
 * service to reach by hostname there. Falls back to the individual DB_HOST/DB_PORT/... vars for
 * local docker-compose development. rejectUnauthorized: false is needed for managed Postgres
 * providers (Neon/Supabase) whose certificate chain isn't in Node's default trust store; DB_SSL=true
 * opts into the same behaviour for a DB_HOST-based connection that also requires SSL.
 */
export function resolveDbConfig(): ResolvedDbConfig {
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl) {
    const parsed = new URL(databaseUrl);
    return {
      host: parsed.hostname,
      port: parsed.port ? parseInt(parsed.port, 10) : 5432,
      username: decodeURIComponent(parsed.username),
      password: decodeURIComponent(parsed.password),
      database: parsed.pathname.replace(/^\//, ''),
      ssl: { rejectUnauthorized: false },
    };
  }

  return {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    username: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
    database: process.env.DB_NAME || 'mentions',
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
  };
}
