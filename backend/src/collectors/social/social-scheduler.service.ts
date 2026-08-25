import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { ConfigService } from '@nestjs/config';
import { SOCIAL_COLLECT_QUEUE } from './social.processor';
import { SourcesService } from '../../sources/sources.service';
import { SourceKind } from '../../sources/source.entity';

const REPEAT_JOB_ID = 'social-poll-schedule';

@Injectable()
export class SocialSchedulerService implements OnModuleInit {
  private readonly logger = new Logger(SocialSchedulerService.name);

  constructor(
    @InjectQueue(SOCIAL_COLLECT_QUEUE) private readonly queue: Queue,
    private readonly config: ConfigService,
    private readonly sourcesService: SourcesService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.sourcesService.ensureSingleton({
      url: 'vk://global-search',
      name: 'VK — поиск по ключевым словам',
      type: SourceKind.SOCIAL_API,
    });

    const everyMinutes = this.config.get<number>('vk.pollIntervalMinutes') ?? 15;
    await this.queue.upsertJobScheduler(
      REPEAT_JOB_ID,
      { every: everyMinutes * 60 * 1000, immediately: true },
      { name: 'social-poll' },
    );
    this.logger.log(`Social scheduler active: polling every ${everyMinutes} minute(s)`);
  }
}
