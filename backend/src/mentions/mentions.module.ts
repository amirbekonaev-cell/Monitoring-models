import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Mention } from './mention.entity';
import { MentionsService } from './mentions.service';
import { MentionsController } from './mentions.controller';
import { SentimentModule } from '../sentiment/sentiment.module';

@Module({
  imports: [TypeOrmModule.forFeature([Mention]), SentimentModule],
  providers: [MentionsService],
  controllers: [MentionsController],
  exports: [MentionsService, TypeOrmModule],
})
export class MentionsModule {}
