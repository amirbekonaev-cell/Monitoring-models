import { BadRequestException, Body, Controller, Get, NotFoundException, Param, Patch, Query } from '@nestjs/common';
import { MentionsService } from './mentions.service';
import { Sentiment } from './mention.entity';

@Controller('mentions')
export class MentionsController {
  constructor(private readonly mentionsService: MentionsService) {}

  @Get()
  async list(@Query('limit') limit?: string, @Query('offset') offset?: string) {
    const parsedLimit = Math.min(Math.max(parseInt(limit ?? '50', 10) || 50, 1), 200);
    const parsedOffset = Math.max(parseInt(offset ?? '0', 10) || 0, 0);
    const { items, total } = await this.mentionsService.findRecent({
      limit: parsedLimit,
      offset: parsedOffset,
    });
    return { items, total, limit: parsedLimit, offset: parsedOffset };
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
