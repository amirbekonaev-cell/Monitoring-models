import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { ConfigService } from '@nestjs/config';
import { TELEGRAM_COLLECT_QUEUE } from './telegram.processor';

const REPEAT_JOB_ID = 'telegram-poll-schedule';

@Injectable()
export class TelegramSchedulerService implements OnModuleInit {
  private readonly logger = new Logger(TelegramSchedulerService.name);

  constructor(
    @InjectQueue(TELEGRAM_COLLECT_QUEUE) private readonly queue: Queue,
    private readonly config: ConfigService,
  ) {}

  async onModuleInit(): Promise<void> {
    const everyMinutes = this.config.get<number>('telegram.pollIntervalMinutes') ?? 10;
    await this.queue.upsertJobScheduler(
      REPEAT_JOB_ID,
      { every: everyMinutes * 60 * 1000, immediately: true },
      { name: 'telegram-poll' },
    );
    this.logger.log(`Telegram scheduler active: polling every ${everyMinutes} minute(s)`);
  }
}
