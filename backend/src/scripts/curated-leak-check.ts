/**
 * Proves, against a running backend, that no closed-pool URL reaches the outside world.
 *
 * Usage: npm run curated:leak-check [-- http://localhost:3000]
 *
 * Fetches everything a stranger with the deployment URL could fetch — GET /mentions (limit 200),
 * GET /mentions/stats, GET /sources — plus the Telegram bot's own rendered message text, and
 * searches each response for any pool URL, for its path, and for its host+path combination. A
 * path alone is enough of a leak to check for: `the-tech.kz` appearing as a source name is
 * harmless, but `/qazcloud-i-clever-cloud-podpisali.../` identifies the exact article.
 *
 * Exits non-zero on any match, so it can be wired into CI. Prints counters and, on a failure,
 * WHICH endpoint and which link id leaked — never the URL itself.
 */
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CuratedLink } from '../curated/curated-link.entity';
import { CuratedSearchService } from '../curated/curated-search.service';
import { buildHeader, buildPage, buildStatusText } from '../curated/curated-message.util';
import { searchPeriodLabel } from '../curated/search-period.util';
import { createCuratedScriptContext, describeDatabase } from './curated-script-context';

const DEFAULT_BASE_URL = process.env.LEAK_CHECK_BASE_URL || 'http://localhost:3000';
/** Period the bot-formatter sample is rendered for — wide enough to include every pool article. */
const BOT_SAMPLE_PERIOD_DAYS = 3650;

interface Probe {
  name: string;
  body: string;
}

async function main(): Promise<void> {
  const baseUrl = (process.argv[2] || DEFAULT_BASE_URL).replace(/\/+$/, '');

  const app = await createCuratedScriptContext();
  const repo = app.get<Repository<CuratedLink>>(getRepositoryToken(CuratedLink));
  const search = app.get(CuratedSearchService);

  console.log(`База: ${describeDatabase()}`);
  console.log(`Проверяемый backend: ${baseUrl}`);

  const links = await repo.find();
  if (links.length === 0) {
    console.warn('Пул пуст — проверять нечего. Сначала выполните npm run curated:import.');
    await app.close();
    return;
  }

  const probes: Probe[] = [];
  for (const [name, path] of [
    ['GET /mentions', '/mentions?limit=200'],
    ['GET /mentions/stats', '/mentions/stats?period=30d'],
    ['GET /sources', '/sources'],
  ] as const) {
    probes.push({ name, body: await fetchText(`${baseUrl}${path}`) });
  }

  probes.push({ name: 'Telegram formatter', body: await renderBotSample(search) });

  let leaks = 0;
  for (const probe of probes) {
    const matched = links.filter((link) => probeContainsLink(probe.body, link));
    if (matched.length === 0) {
      console.log(`  OK  ${probe.name} (${probe.body.length} байт) — совпадений 0`);
      continue;
    }
    leaks += matched.length;
    console.error(`  УТЕЧКА  ${probe.name}: найдено ${matched.length} ссыл(ок) из пула`);
    for (const link of matched) {
      console.error(`      link id=${link.id} host=${link.host ?? '?'} (сам URL здесь намеренно не печатается)`);
    }
  }

  await app.close();

  if (leaks > 0) {
    console.error(`\nПроверка не пройдена: ${leaks} совпадени(й). Ссылки пула не должны попадать наружу.`);
    process.exit(1);
  }
  console.log(`\nПроверка пройдена: ${links.length} ссылок пула, 0 совпадений в ${probes.length} ответах.`);
}

/**
 * Three ways the same link could show through: the whole URL, its path+query (the identifying
 * part), and host+path without a scheme. JSON-escaped forward slashes are normalized away first
 * so an escaped `\/` in a JSON body cannot hide a match.
 */
function probeContainsLink(body: string, link: CuratedLink): boolean {
  const haystack = body.replace(/\\\//g, '/').toLowerCase();
  const candidates = new Set<string>([link.url.toLowerCase()]);
  try {
    const parsed = new URL(link.url);
    const pathAndQuery = `${parsed.pathname}${parsed.search}`.toLowerCase();
    // A bare "/" path carries no identity — skip it rather than matching every response.
    if (pathAndQuery.length > 1) {
      candidates.add(pathAndQuery);
      candidates.add(`${parsed.hostname}${pathAndQuery}`.toLowerCase());
    }
  } catch {
    // A malformed stored URL can only be checked verbatim.
  }
  return [...candidates].some((candidate) => haystack.includes(candidate));
}

/** Renders what the bot would actually send for /search and /status, through the real formatters. */
async function renderBotSample(search: CuratedSearchService): Promise<string> {
  const result = await search.search(BOT_SAMPLE_PERIOD_DAYS);
  const items = await search.findPage(BOT_SAMPLE_PERIOD_DAYS, 0, 200);
  const label = searchPeriodLabel(BOT_SAMPLE_PERIOD_DAYS);
  const timezone = process.env.SEARCH_TIMEZONE || 'Asia/Almaty';

  const header = buildHeader(label, result);
  const page = buildPage({ header, items, startIndex: 1, timezone, charLimit: 1_000_000 });
  return [page.text, buildStatusText(result.pool, timezone)].join('\n\n');
}

async function fetchText(url: string): Promise<string> {
  try {
    const res = await fetch(url);
    return await res.text();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`  ПРОПУСК  ${url}: backend недоступен (${message}) — этот ответ не проверен`);
    return '';
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
