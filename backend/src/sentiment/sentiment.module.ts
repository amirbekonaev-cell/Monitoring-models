import { Module } from '@nestjs/common';
import { SentimentAnalysisService } from './sentiment-analysis.service';
import { ParserCollectorModule } from '../collectors/parser/parser.module';

@Module({
  imports: [ParserCollectorModule],
  providers: [SentimentAnalysisService],
  exports: [SentimentAnalysisService],
})
export class SentimentModule {}
