import { AppDataSource } from '../database/data-source';
import { describeDatabase } from './curated-script-context';
import { hashMentionText } from '../common/hash.util';
import { Mention, MentionSourceType } from '../mentions/mention.entity';
import { CuratedLink } from '../curated/curated-link.entity';
import { Source, SourceKind, SourceStatus } from '../sources/source.entity';
import {
  CURATED_MENTIONS,
  CURATED_SENTIMENT_TO_ENUM,
  CuratedMention,
  normalizeUrl,
} from '../curated/curated-mentions';

/**
 * Переносит вручную проверенные карточки упоминаний в таблицу `mentions`.
 *
 * Запуск:
 *   npm run seed:curated -- --dry-run   показать план, ничего не записывая
 *   npm run seed:curated                применить
 *
 * Как это работает и почему именно так
 * ------------------------------------
 * Материалы из набора УЖЕ есть в базе: их туда положил закрытый пул (CuratedIngestService) с
 * `url_hidden = true`, с заголовком и пересказом от модели. Карточки описывают те же статьи,
 * только текст и тональность в них написаны человеком. Поэтому скрипт не вставляет вторую
 * строку на ту же статью, а обновляет существующую: заменяет машинный текст ручным и ставит
 * `sentiment_manual = true`.
 *
 * Сопоставление идёт по НОРМАЛИЗОВАННОМУ url (normalizeUrl), а не по точному совпадению строки:
 * пул хранит ссылки без завершающего слеша, в карточках он есть у 79 из 167. Поиск по точному
 * url нашёл бы только 88 статей, а для остальных 79 создал бы дубликаты — причём видимые
 * (`url_hidden = false`), то есть 79 ссылок закрытого пула утекли бы в публичный GET /mentions
 * и уронили бы `npm run curated:leak-check`.
 *
 * Что скрипт НЕ трогает у существующих строк: `hash` (он уникален и участвует в дедупликации —
 * пересчёт мог бы столкнуться с чужой строкой), `source_id`, `url_hidden`, `curated_link_id`,
 * `keywords`, `language`. Меняется только то, что человек написал руками, плюс два флага-замка.
 *
 * Почему запись идёт напрямую через репозиторий, а не через MentionsService.createIfNew:
 * createIfNew прогоняет вставку через проверку похожести (pg_trgm) и склеил бы часть карточек
 * в «перепечатки» друг друга — все 168 материалов про одну компанию, заголовки и пересказы у
 * них закономерно похожи, а окно сравнения ±5 дней накрывает сразу несколько публикаций об
 * одном событии. Здесь каждая карточка — отдельная проверенная человеком запись, склеивать их
 * нельзя. Кроме того, createIfNew не умеет принимать ни готовую тональность, ни
 * `sentimentManual`: он жёстко ставит `notificationSent = isBackfill` и считает тональность сам.
 *
 * Три замка, которые ставит скрипт:
 *  - `sentimentManual = true`  — фоновый классификатор не перетрёт ручную оценку. Это проверено
 *    на уровне SQL: и MentionsService.updateSentiment, и classify-sentiment-backfill.ts пишут
 *    только `WHERE sentiment_manual = false`, а сам backfill ещё и выбирает строки тем же
 *    условием, так что карточки в выборку вообще не попадают.
 *  - `notificationSent = true` — алерт по этим упоминаниям не уйдёт.
 *  - `isBackfill = true` (только у новых строк) — пометка «историческая догрузка».
 *
 * Повторный запуск идемпотентен: на вход подаются одни и те же значения, поэтому второй прогон
 * сообщает «без изменений» и ничего не пишет.
 */

const DRY_RUN = process.argv.includes('--dry-run');

const KEYWORDS = ['QazCloud'];

/**
 * День публикации фиксируется в полночь UTC, а не в полночь Asia/Almaty со сдвигом +06:00, как
 * было в черновике. Казахстан в марте 2024 перешёл на единый UTC+5, поэтому литерал +06:00 для
 * статьи 2024–2026 годов даёт 18:00 UTC предыдущего дня, и в Asia/Almaty она отображается
 * ВЧЕРАШНИМ числом. Полночь UTC показывается тем же календарным днём в любом поясе от UTC+0 до
 * UTC+11, то есть дата из карточки не «уезжает» на сутки.
 */
function toPublishedAt(day: string | null): Date | null {
  return day ? new Date(`${day}T00:00:00Z`) : null;
}

/** Хост ссылки без www — для сопоставления карточки с уже заведённым источником. */
function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return null;
  }
}

/**
 * По одной карточке на статью. 3.14 — сознательный дубликат 3.10 с общим URL, в базе должна
 * остаться одна запись; при совпадении ссылок берём оригинал, а не дубликат.
 */
function dedupeByUrl(items: CuratedMention[]): CuratedMention[] {
  const byUrl = new Map<string, CuratedMention>();
  for (const item of items) {
    const key = normalizeUrl(item.url);
    const kept = byUrl.get(key);
    if (!kept || (kept.status === 'duplicate' && item.status !== 'duplicate')) {
      byUrl.set(key, item);
    }
  }
  return [...byUrl.values()];
}

/**
 * Источник для НОВОЙ строки. Существующие строки свой `source_id` сохраняют — у материалов пула
 * это системный источник `curated://internal`, и переписывать его значило бы задним числом
 * менять их происхождение.
 *
 * Новый источник создаётся со `status = DISABLED`, а не ACTIVE, как было в черновике. Сборщик
 * сейчас ходит только по источникам, которые заводит админ через онбординг
 * (SourceOnboardingService), расписания в проекте нет — то есть ACTIVE прямо сегодня ничего бы
 * не запустил. Но ACTIVE означает «отсюда собираем», и когда фоновый сбор включат обратно, 20
 * изданий из набора начали бы обходиться краулером и плодить вторые копии тех же статей.
 * DISABLED описывает реальную роль такой записи: она нужна как подпись издания, а не как
 * источник для обхода.
 */
async function resolveSourceForInsert(card: CuratedMention, cache: Map<string, Source>): Promise<Source> {
  const cached = cache.get(card.sourceDomain);
  if (cached) {
    return cached;
  }

  const repo = AppDataSource.getRepository(Source);
  const existing = (await repo.find()).find((s) => hostOf(s.url) === card.sourceDomain);
  if (existing) {
    cache.set(card.sourceDomain, existing);
    return existing;
  }

  const created = await repo.save(
    repo.create({
      name: card.sourceName,
      url: `https://${card.sourceDomain}/`,
      type: SourceKind.PARSER,
      status: SourceStatus.DISABLED,
      createdBy: 'seed-curated',
    }),
  );
  cache.set(card.sourceDomain, created);
  return created;
}

/** Поля, которые скрипт имеет право переписать у существующей строки. */
function buildUpdate(card: CuratedMention, existing: Mention): Partial<Mention> {
  const patch: Partial<Mention> = {
    title: card.title,
    text: card.summary,
    summary: card.summary,
    sentiment: CURATED_SENTIMENT_TO_ENUM[card.sentiment],
    sentimentManual: true,
    notificationSent: true,
  };

  // У 13.14 даты на сайте нет. Затирать уже известную дату на null незачем — это потеря
  // информации, а не перенос ручных данных; поэтому дата обновляется, только если она в
  // карточке есть.
  const publishedAt = toPublishedAt(card.publishedAt);
  if (publishedAt && existing.publishedAt?.getTime() !== publishedAt.getTime()) {
    patch.publishedAt = publishedAt;
  }

  return patch;
}

function isUnchanged(patch: Partial<Mention>, existing: Mention): boolean {
  return (Object.keys(patch) as Array<keyof Mention>).every((key) => {
    const next = patch[key];
    const current = existing[key];
    if (next instanceof Date && current instanceof Date) {
      return next.getTime() === current.getTime();
    }
    return next === current;
  });
}

async function run(): Promise<void> {
  await AppDataSource.initialize();
  const mentionsRepo = AppDataSource.getRepository(Mention);
  const linksRepo = AppDataSource.getRepository(CuratedLink);

  const cards = dedupeByUrl(CURATED_MENTIONS);

  // Весь индекс строится один раз в памяти: таблица небольшая, а 167 отдельных запросов с
  // нормализацией на стороне SQL читались бы хуже и работали бы дольше.
  const byUrl = new Map<string, Mention>();
  for (const mention of await mentionsRepo.find()) {
    byUrl.set(normalizeUrl(mention.url), mention);
  }

  // Ссылка из закрытого пула остаётся скрытой и после вставки: иначе её увидит
  // неаутентифицированный GET /mentions, и `npm run curated:leak-check` покраснеет.
  const poolUrls = new Set((await linksRepo.find()).map((link) => normalizeUrl(link.url)));

  const sourceCache = new Map<string, Source>();
  const existingHashes = new Set((await mentionsRepo.find({ select: ['hash'] })).map((m) => m.hash));

  let inserted = 0;
  let updated = 0;
  let unchanged = 0;
  let skipped = 0;

  // База называется до первой записи намеренно. backend/.env задаёт DATABASE_URL, а он в
  // resolveDbConfig() сильнее, чем DB_HOST, — поэтому запуск из backend/ идёт не в локальный
  // docker-compose, а в удалённую базу деплоя. Разница видна сразу по числу упоминаний.
  console.log(`База: ${describeDatabase()}`);
  console.log(
    `Карточек: ${CURATED_MENTIONS.length} (уникальных по ссылке: ${cards.length}), ` +
      `упоминаний в базе: ${byUrl.size}, ссылок в пуле: ${poolUrls.size}`,
  );
  console.log(DRY_RUN ? '\nРЕЖИМ --dry-run: база НЕ изменяется.\n' : '\nЗапись в базу.\n');

  for (const card of cards) {
    const key = normalizeUrl(card.url);
    const existing = byUrl.get(key);

    if (existing) {
      const patch = buildUpdate(card, existing);
      if (isUnchanged(patch, existing)) {
        unchanged += 1;
        continue;
      }
      updated += 1;
      console.log(
        `обновить  [${card.id}] ${card.sourceDomain}` +
          `${existing.urlHidden ? ' (строка пула, остаётся скрытой)' : ''}` +
          ` — тональность ${existing.sentiment} -> ${patch.sentiment}`,
      );
      if (!DRY_RUN) {
        await mentionsRepo.update(existing.id, patch);
      }
      continue;
    }

    const hash = hashMentionText(card.title, card.summary);
    if (existingHashes.has(hash)) {
      // hash — UNIQUE на уровне БД. Совпадение здесь означает, что ровно такой заголовок и
      // пересказ уже лежат в базе под другим адресом; вставка упала бы с ошибкой уникальности.
      skipped += 1;
      console.warn(`пропустить [${card.id}] ${card.sourceDomain} — такой заголовок и пересказ уже есть в базе`);
      continue;
    }

    const source = await resolveSourceForInsert(card, sourceCache);
    const urlHidden = poolUrls.has(key);
    inserted += 1;
    console.log(`добавить  [${card.id}] ${card.sourceDomain}${urlHidden ? ' (ссылка пула — скрытая)' : ''}`);

    if (!DRY_RUN) {
      await mentionsRepo.save(
        mentionsRepo.create({
          title: card.title,
          text: card.summary,
          summary: card.summary,
          url: card.url,
          publishedAt: toPublishedAt(card.publishedAt),
          sourceId: source.id,
          sourceType: MentionSourceType.NEWS,
          sentiment: CURATED_SENTIMENT_TO_ENUM[card.sentiment],
          sentimentManual: true,
          hash,
          keywords: KEYWORDS,
          notificationSent: true,
          isBackfill: true,
          urlHidden,
        }),
      );
      existingHashes.add(hash);
    }
  }

  console.log(
    `\nИтого: добавить ${inserted}, обновить ${updated}, без изменений ${unchanged}, пропустить ${skipped}.`,
  );
  if (DRY_RUN) {
    console.log('Ничего не записано (--dry-run). Повторите команду без флага, чтобы применить.');
  }

  await AppDataSource.destroy();
}

run().catch((error) => {
  console.error('seed:curated упал:', error);
  process.exit(1);
});
