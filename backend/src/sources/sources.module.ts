import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Source } from './source.entity';
import { SourcesService } from './sources.service';
import { SourcesController } from './sources.controller';
import { MentionsModule } from '../mentions/mentions.module';
import { CommonModule } from '../common/common.module';
import { DomainExclusionEnforcerService } from './domain-exclusion-enforcer.service';

@Module({
  imports: [TypeOrmModule.forFeature([Source]), MentionsModule, CommonModule],
  controllers: [SourcesController],
  providers: [SourcesService, DomainExclusionEnforcerService],
  exports: [SourcesService, TypeOrmModule],
})
export class SourcesModule {}