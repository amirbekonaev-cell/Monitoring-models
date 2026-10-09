import { BadRequestException, Body, Controller, Get, NotFoundException, Param, Patch, Query } from '@nestjs/common';
import { MentionsService, MentionFilters } from './mentions.service';
import { MentionSourceType, Sentiment } from './mention.entity';

interface RawFilterParams {
  sentiment?: string;
  sourceId?: string;
  sourceType?: string;
  language?: string;
  search?: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

// Matches the Telegram bot's period picker (curated/search-period.util.ts DEFAULT_SEARCH_PERIOD_DAYS)
// so the frontend and /search never disagree about what "3 месяца"/"год"/"2 года" mean. The closed
// pool's mentions are historical (dates spanning years, backfilled all at once — see README
// "Закрытый пул ссылок"), so the frontend's old '7d'/'30d'-only presets hid nearly all of it by
// default; found live: /mentions?limit=5 (no period) returned 177 items, but every period-scoped
// view showed close to none.
const PERIOD_DAYS: Record<string, number> = {
  '7d': 7,
  '30d': 30,
  '60d': 60,
  '90d': 90,
  '180d': 180,
  '365d': 365,
  '730d': 730,
};

@Controller('mentions')
export class MentionsController {
  constructor(private readonly mentionsService: MentionsService) {}

  @Get()
  async list(
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('sentiment') sentiment?: string,
    @Query('sourceId') sourceId?: string,
    @Query('sourceType') sourceType?: string,
    @Query('language') language?: string,
    @Query('search') search?: string,
    @Query('period') period?: string,
    @Query('dateFrom') dateFrom?: string,
    @Query('dateTo') dateTo?: string,
  ) {
    const parsedLimit = Math.min(Math.max(parseInt(limit ?? '50', 10) || 50, 1), 200);
    const parsedOffset = Math.max(parseInt(offset ?? '0', 10) || 0, 0);
    const filters = this.parseFilters({ sentiment, sourceId, sourceType, language, search });
    const range = period || (dateFrom && dateTo) ? this.resolveRange(period, dateFrom, dateTo) : {};
    const { items, total } = await this.mentionsService.findRecent({
      limit: parsedLimit,
      offset: parsedOffset,
      ...filters,
      ...range,
    });
    return { items, total, limit: parsedLimit, offset: parsedOffset };
  }

  /** Агрегация для дашборда — те же фильтры, что и /mentions, но за период (по умолчанию 7 дней). */
  @Get('stats')
  async stats(
    @Query('sentiment') sentiment?: string,
    @Query('sourceId') sourceId?: string,
    @Query('sourceType') sourceType?: string,
    @Query('language') language?: string,
    @Query('search') search?: string,
    @Query('period') period?: string,
    @Query('dateFrom') dateFrom?: string,
    @Query('dateTo') dateTo?: string,
  ) {
    const filters = this.parseFilters({ sentiment, sourceId, sourceType, language, search });
    const { dateFrom: from, dateTo: to } = this.resolveRange(period, dateFrom, dateTo);
    return this.mentionsService.getStats({ ...filters, dateFrom: from, dateTo: to });
  }

  private parseFilters(raw: RawFilterParams): MentionFilters {
    const filters: MentionFilters = {};
    if (raw.sentiment) {
      if (!Object.values(Sentiment).includes(raw.sentiment as Sentiment)) {
        throw new BadRequestException(
          `Недопустимое значение тональности: "${raw.sentiment}" (ожидается одно из: ${Object.values(Sentiment).join(', ')})`,
        );
      }
      filters.sentiment = raw.sentiment as Sentiment;
    }
    if (raw.sourceType) {
      if (!Object.values(MentionSourceType).includes(raw.sourceType as MentionSourceType)) {
        throw new BadRequestException(
          `Недопустимый тип источника: "${raw.sourceType}" (ожидается одно из: ${Object.values(MentionSourceType).join(', ')})`,
        );
      }
      filters.sourceType = raw.sourceType as MentionSourceType;
    }
    if (raw.sourceId) {
      filters.sourceId = raw.sourceId;
    }
    if (raw.language) {
      filters.language = raw.language;
    }
    if (raw.search && raw.search.trim()) {
      filters.search = raw.search.trim();
    }
    return filters;
  }

  /** `dateFrom`/`dateTo` (ISO) win over `period` when both are given (произвольный диапазон дат). */
  private resolveRange(period?: string, dateFromStr?: string, dateToStr?: string): { dateFrom: Date; dateTo: Date } {
    if (dateFromStr && dateToStr) {
      const dateFrom = new Date(dateFromStr);
      const dateTo = new Date(dateToStr);
      if (Number.isNaN(dateFrom.getTime()) || Number.isNaN(dateTo.getTime())) {
        throw new BadRequestException('Некорректные даты периода: ожидается ISO-формат в dateFrom/dateTo');
      }
      return { dateFrom, dateTo };
    }

    const dateTo = new Date();
    if (period === 'today') {
      const dateFrom = new Date(dateTo);
      dateFrom.setHours(0, 0, 0, 0);
      return { dateFrom, dateTo };
    }
    if (!period || period === '7d') {
      // No period given at all (e.g. a request that only sent sentiment/sourceId) keeps the old
      // implicit default — everything else below is explicit and rejects anything unrecognised
      // instead of silently defaulting to it, see PERIOD_DAYS below.
      return { dateFrom: new Date(dateTo.getTime() - 7 * DAY_MS), dateTo };
    }
    const days = PERIOD_DAYS[period];
    if (days === undefined) {
      throw new BadRequestException(
        `Недопустимое значение периода: "${period}" (ожидается одно из: ${Object.keys(PERIOD_DAYS).join(', ')}, today, ` +
          'либо dateFrom/dateTo)',
      );
    }
    return { dateFrom: new Date(dateTo.getTime() - days * DAY_MS), dateTo };
  }

  /** ФТ-11: ручная правка тональности. Всегда побеждает автоматику — см. MentionsService.updateSentiment. */
  @Patch(':id/sentiment')
  async updateSentiment(@Param('id') id: string, @Body('sentiment') sentiment: string) {
    if (!Object.values(Sentiment).includes(sentiment as Sentiment)) {
      throw new BadRequestException(
        `Недопустимое значение тональности: "${sentiment}" (ожидается одно из: ${Object.values(Sentiment).join(', ')})`,
      );
    }
    const updated = await this.mentionsService.updateSentimentManually(id, sentiment as Sentiment);
    if (!updated) {
      throw new NotFoundException(`Упоминание ${id} не найдено`);
    }
    return updated;
  }
}
