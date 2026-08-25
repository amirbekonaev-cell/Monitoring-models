import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Source } from './source.entity';
import { SourcesService } from './sources.service';
import { SourcesController } from './sources.controller';
import { MentionsModule } from '../mentions/mentions.module';

@Module({
  imports: [TypeOrmModule.forFeature([Source]), MentionsModule],
  controllers: [SourcesController],
  providers: [SourcesService],
  exports: [SourcesService, TypeOrmModule],
})
export class SourcesModule {}
