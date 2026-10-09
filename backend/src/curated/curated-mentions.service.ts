import { Injectable, Logger } from '@nestjs/common';
import {
  CURATED_MENTIONS,
  CuratedMention,
  CuratedSentiment,
  CuratedStats,
  findCuratedById,
  findCuratedByUrl,
  formatCuratedMessage,
  formatCuratedPlain,
  getCuratedBySentiment,
  getCuratedBySource,
  getCuratedSortedByDate,
  getCuratedStats,
  hasCurated,
} from './curated-mentions';

/**
 * Доступ к готовым карточкам упоминаний из DI-контейнера Nest.
 *
 * Данные лежат в памяти (167 записей из curated-mentions.data.json), в БД ходить не нужно.
 * Сервис ничего не генерирует: отдаёт уже написанный человеком текст.
 */
@Injectable()
export class CuratedMentionsService {
  private readonly logger = new Logger(CuratedMentionsService.name);

  constructor() {
    this.logger.log(`Загружено готовых карточек упоминаний: ${CURATED_MENTIONS.length}`);
  }

  all(): CuratedMention[] {
    return CURATED_MENTIONS;
  }

  sortedByDate(): CuratedMention[] {
    return getCuratedSortedByDate();
  }

  byUrl(url: string): CuratedMention | undefined {
    return findCuratedByUrl(url);
  }

  byId(id: string): CuratedMention | undefined {
    return findCuratedById(id);
  }

  has(url: string): boolean {
    return hasCurated(url);
  }

  bySource(domain: string): CuratedMention[] {
    return getCuratedBySource(domain);
  }

  bySentiment(sentiment: CuratedSentiment): CuratedMention[] {
    return getCuratedBySentiment(sentiment);
  }

  stats(): CuratedStats {
    return getCuratedStats();
  }

  /** Текст одного Telegram-сообщения (HTML) для карточки. */
  formatMessage(mention: CuratedMention): string {
    return formatCuratedMessage(mention);
  }

  formatPlain(mention: CuratedMention): string {
    return formatCuratedPlain(mention);
  }
}
