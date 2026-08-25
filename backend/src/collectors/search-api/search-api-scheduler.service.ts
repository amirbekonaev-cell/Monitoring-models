import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { ConfigService } from '@nestjs/config';
import { SEARCH_API_COLLECT_QUEUE } from './search-api.processor';
import { SourcesService } from '../../sources/sources.service';
import { SourceKind } from '../../sources/source.entity';

const REPEAT_JOB_ID = 'search-api-poll-schedule';

@Injectable()
export class SearchApiSchedulerService implements OnModuleInit {
  private readonly logger = new Logger(SearchApiSchedulerService.name);

  constructor(
    @InjectQueue(SEARCH_API_COLLECT_QUEUE) private readonly queue: Queue,
    private readonly config: ConfigService,
    private readonly sourcesService: SourcesService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.sourcesService.ensureSingleton({
      url: 'newsapi://global-search',
      name: 'NewsAPI — поиск по ключевым словам',
      type: SourceKind.SEARCH_API,
    });

    const everyMinutes = this.config.get<number>('newsApi.pollIntervalMinutes') ?? 15;
    await this.queue.upsertJobScheduler(
      REPEAT_JOB_ID,
      { every: everyMinutes * 60 * 1000, immediately: true },
      { name: 'search-api-poll' },
    );
    this.logger.log(`Search API scheduler active: polling every ${everyMinutes} minute(s)`);
  }
}
