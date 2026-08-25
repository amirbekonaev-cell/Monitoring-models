import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { ConfigService } from '@nestjs/config';
import { PARSER_COLLECT_QUEUE } from './parser.processor';

const REPEAT_JOB_ID = 'parser-poll-schedule';

@Injectable()
export class ParserSchedulerService implements OnModuleInit {
  private readonly logger = new Logger(ParserSchedulerService.name);

  constructor(
    @InjectQueue(PARSER_COLLECT_QUEUE) private readonly queue: Queue,
    private readonly config: ConfigService,
  ) {}

  async onModuleInit(): Promise<void> {
    const everyMinutes = this.config.get<number>('parser.pollIntervalMinutes') ?? 20;
    await this.queue.upsertJobScheduler(
      REPEAT_JOB_ID,
      { every: everyMinutes * 60 * 1000, immediately: true },
      { name: 'parser-poll' },
    );
    this.logger.log(`Parser scheduler active: polling every ${everyMinutes} minute(s)`);
  }
}
