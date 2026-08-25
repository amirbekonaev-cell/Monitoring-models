import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { ConfigService } from '@nestjs/config';
import { RSS_COLLECT_QUEUE } from './rss.processor';

const REPEAT_JOB_ID = 'rss-poll-schedule';

@Injectable()
export class RssSchedulerService implements OnModuleInit {
  private readonly logger = new Logger(RssSchedulerService.name);

  constructor(
    @InjectQueue(RSS_COLLECT_QUEUE) private readonly queue: Queue,
    private readonly config: ConfigService,
  ) {}

  async onModuleInit(): Promise<void> {
    const everyMinutes = this.config.get<number>('rss.pollIntervalMinutes') ?? 10;

    // `immediately: true` runs the first cycle right away instead of waiting a full interval,
    // so data shows up without a long wait after startup.
    await this.queue.upsertJobScheduler(
      REPEAT_JOB_ID,
      { every: everyMinutes * 60 * 1000, immediately: true },
      { name: 'rss-poll' },
    );

    this.logger.log(`RSS scheduler active: polling every ${everyMinutes} minute(s)`);
  }
}
