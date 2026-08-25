import { Body, Controller, Delete, Get, Param, Patch } from '@nestjs/common';
import { SourcesService } from './sources.service';
import { MentionsService } from '../mentions/mentions.service';

@Controller('sources')
export class SourcesController {
  constructor(
    private readonly sourcesService: SourcesService,
    private readonly mentionsService: MentionsService,
  ) {}

  @Get()
  async findAll() {
    const sources = await this.sourcesService.findAll();
    const withCounts = await Promise.all(
      sources.map(async (source) => ({
        ...source,
        mentionsCount: await this.mentionsService.countBySource(source.id),
      })),
    );
    return withCounts;
  }

  @Patch(':id')
  async setEnabled(@Param('id') id: string, @Body() body: { enabled: boolean }) {
    await this.sourcesService.setEnabled(id, body.enabled);
    return this.sourcesService.findById(id);
  }

  @Delete(':id')
  async remove(@Param('id') id: string) {
    await this.sourcesService.remove(id);
    return { ok: true };
  }
}
