import { Module } from '@nestjs/common';
import { NewsApiService } from './newsapi.service';

@Module({
  providers: [NewsApiService],
  exports: [NewsApiService],
})
export class SearchApiCollectorModule {}
