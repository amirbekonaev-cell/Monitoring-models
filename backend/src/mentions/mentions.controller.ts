import { Controller, Get, Query } from '@nestjs/common';
import { MentionsService } from './mentions.service';

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
}
