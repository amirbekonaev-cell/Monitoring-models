import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { KeywordsService } from './keywords.service';
import { KeywordType } from './keyword.entity';

@Controller('keywords')
export class KeywordsController {
  constructor(private readonly keywordsService: KeywordsService) {}

  @Get()
  findAll() {
    return this.keywordsService.findAll();
  }

  @Post()
  create(
    @Body()
    body: {
      phrase: string;
      type?: KeywordType;
      language?: string;
      manualForms?: string[];
      isActive?: boolean;
    },
  ) {
    return this.keywordsService.create({
      phrase: body.phrase,
      type: body.type ?? KeywordType.REQUIRED,
      language: body.language,
      manualForms: body.manualForms,
      isActive: body.isActive,
    });
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body()
    body: {
      phrase?: string;
      type?: KeywordType;
      language?: string;
      manualForms?: string[];
      isActive?: boolean;
    },
  ) {
    return this.keywordsService.update(id, body);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.keywordsService.remove(id);
  }
}
