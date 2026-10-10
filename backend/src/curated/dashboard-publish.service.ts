import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash } from 'crypto';
import { Repository } from 'typeorm';
import { Mention, MentionSourceType } from '../mentions/mention.entity';
import { CURATED_SEARCH_SOURCE, CuratedMentionView, CuratedSearchSource } from './curated-search.types';

export interface DashboardPublishOutcome {
  periodDays: number;
  /** Окно, за которое опубликован набор — те же календарные даты, что в сообщении бота. */
  dateFrom: string;
  dateTo: string;
  /** Сколько строк было в `mentions` до публикации (все они удалены). */
  removed: number;
  /** Сколько строк вставлено — ровно столько материалов и покажут дашборд и лента. */
  published: number;
}

/**
 * Сколько строк вставляется одним INSERT. У `mentions` ~18 колонок, лимит параметров Postgres —
 * 65535, так что 200 строк за запрос (≈3600 параметров) с большим запасом внутри лимита и при
 * этом не превращают набор в пару сотен отдельных запросов.
 */
const INSERT_CHUNK_SIZE = 200;

/**
 * Переносит выдачу бота в таблицу `mentions` — то, что читают дашборд и лента веб-интерфейса
 * (GET /mentions, GET /mentions/stats).
 *
 * Смысл один: в дашборде лежит РОВНО последняя выдача бота, и ничего больше. Поэтому publish()
 * не добавляет к тому, что уже есть, а ЗАМЕНЯЕТ содержимое таблицы: сначала удаляются все
 * упоминания, потом вставляются карточки выбранного периода. Нажали «3 месяца» — в дашборде
 * материалы за три месяца; нажали «Всё время» — весь набор. Ни выдачи от прежних нажатий, ни
 * упоминаний от старых каналов сбора (по ключевым словам, по городам) после этого не остаётся.
 *
 * Данные берутся из того же CURATED_SEARCH_SOURCE, что отвечает на /search, и теми же вызовами
 * (search + findPage), поэтому дашборд не может разойтись с сообщением в Telegram: один фильтр по
 * одному окну.
 *
 * Запись идёт напрямую через репозиторий, а не через MentionsService.createIfNew, намеренно:
 *  - createIfNew прогоняет вставку через проверку похожести (pg_trgm) и склеил бы часть карточек
 *    в «перепечатки» друг друга — материалы про одну компанию закономерно похожи;
 *  - он же запускает определение тональности через OpenAI, а тональность в карточках уже написана
 *    человеком: платить за её повторный вывод не нужно, и путь /search обязан работать вообще без
 *    OPENAI_API_KEY в окружении.
 *
 * ПРИВАТНОСТЬ. Сюда попадают только карточки из curated-mentions.data.json — публичные новостные
 * материалы из собранного человеком списка, поэтому строки вставляются с `urlHidden = false` и
 * ссылка видна в ленте. Ссылки ЗАКРЫТОГО пула этим путём не публикуются: их отдаёт
 * CuratedSearchService, у которого `url` всегда null, а материал без адреса пропускается
 * (hasPublicUrl) — см. README «Приватность».
 */
@Injectable()
export class DashboardPublishService {
  private readonly logger = new Logger(DashboardPublishService.name);

  constructor(
    @InjectRepository(Mention)
    private readonly mentionsRepo: Repository<Mention>,
    @Inject(CURATED_SEARCH_SOURCE)
    private readonly searchSource: CuratedSearchSource,
  ) {}

  /**
   * Публикует выдачу за период: удаляет всё, что было в `mentions`, и вставляет найденное.
   *
   * Обе операции — в одной транзакции, чтобы дашборд не оказался пустым из-за упавшей вставки:
   * либо он показывает новую выдачу целиком, либо остаётся прежним.
   */
  async publish(periodDays: number, now: Date = new Date()): Promise<DashboardPublishOutcome> {
    const result = await this.searchSource.search(periodDays, now);
    const items = await this.searchSource.findPage(periodDays, 0, result.total, now);
    const publishable = items.filter((item) => hasPublicUrl(item));

    const outcome = await this.mentionsRepo.manager.transaction(async (manager) => {
      const removed = await manager.createQueryBuilder().delete().from(Mention).execute();
      let published = 0;
      for (const chunk of chunked(publishable, INSERT_CHUNK_SIZE)) {
        await manager
          .createQueryBuilder()
          .insert()
          .into(Mention)
          .values(chunk.map((item) => toMentionRow(item)))
          .execute();
        published += chunk.length;
      }
      return { removed: removed.affected ?? 0, published };
    });

    const skipped = items.length - publishable.length;
    this.logger.log(
      `Дашборд обновлён по выдаче за ${periodDays} дн. (${result.dateFrom} — ${result.dateTo}): ` +
        `удалено прежних упоминаний ${outcome.removed}, опубликовано ${outcome.published}` +
        (skipped > 0 ? `, пропущено без публичной ссылки ${skipped}` : ''),
    );

    return {
      periodDays,
      dateFrom: result.dateFrom,
      dateTo: result.dateTo,
      removed: outcome.removed,
      published: outcome.published,
    };
  }

  /** Полная очистка ленты и дашборда — ничего не вставляет. Возвращает число удалённых строк. */
  async clear(): Promise<number> {
    const result = await this.mentionsRepo.createQueryBuilder().delete().from(Mention).execute();
    const removed = result.affected ?? 0;
    this.logger.warn(`Лента и дашборд очищены: удалено упоминаний — ${removed}`);
    return removed;
  }

  /** Сколько упоминаний сейчас видит дашборд — для подтверждения перед очисткой. */
  count(): Promise<number> {
    return this.mentionsRepo.count();
  }
}

/**
 * Материал без публичного адреса в дашборд не попадает. Это ровно то, что отдаёт
 * CuratedSearchService (закрытый пул): у него `url` всегда null. Вставлять такую строку нечем —
 * колонка `url` обязательна, а пустая строка выглядела бы в ленте как битая ссылка, — поэтому
 * материал пропускается, а сколько их было, пишется в лог.
 */
function hasPublicUrl(item: CuratedMentionView): boolean {
  return typeof item.url === 'string' && item.url.trim().length > 0;
}

function toMentionRow(item: CuratedMentionView): Partial<Mention> {
  const text = item.summary ?? item.snippet ?? '';
  return {
    title: item.title,
    // Пересказ из карточки — единственный текст, который у материала есть: исходную статью не
    // скачивали. Поэтому он идёт и в `text` (его показывает карточка в ленте), и в `summary`.
    text,
    summary: text === '' ? null : text,
    url: item.url as string,
    publishedAt: item.publishedAt,
    // Издание подписывается через sourceLabel, а не записью в `sources`: материалы набора не
    // обходятся сборщиком, и источник на каждый домен засорил бы вкладку «Источники» списком
    // отключённых сайтов. Дашборд читает подпись отсюда — см. MentionsService.getStats.
    sourceId: null,
    sourceType: MentionSourceType.NEWS,
    sourceLabel: item.sourceLabel,
    sentiment: item.sentiment,
    // Тональность в карточке написана человеком, поэтому строка сразу помечена как ручная: фоновый
    // классификатор (MentionsService.updateSentiment, classify-sentiment-backfill) пишет только
    // `WHERE sentiment_manual = false` и такую оценку не перетрёт.
    sentimentManual: true,
    hash: dashboardHash(item.id),
    keywords: [],
    reprints: [],
    // Рассылать по этим материалам нечего: пользователь только что получил их в Telegram сам.
    notificationSent: true,
    isBackfill: true,
    // Публичная ссылка из списка — mention-privacy.util.ts её не вырезает, и в ленте заголовок
    // кликабельный.
    urlHidden: false,
    curatedLinkId: null,
  };
}

/**
 * Стабильный ключ строки по id карточки ("17.13"). `hash` — UNIQUE varchar(64), и одна карточка
 * обязана давать одну строку: иначе повторная публикация того же периода (а её делает каждое
 * нажатие кнопки) могла бы положить материал дважды.
 */
function dashboardHash(cardId: string): string {
  return createHash('sha256').update(`dashboard:${cardId}`).digest('hex');
}

function chunked<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}
