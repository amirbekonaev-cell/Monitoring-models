import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { SourcesService } from './sources.service';
import { SourceStatus } from './source.entity';
import { DomainExclusionService } from '../common/domain-exclusion.service';

/**
 * On every backend startup, disables any registry row in `sources` whose URL falls under
 * EXCLUDED_DOMAINS — the same effect as an admin clicking "disable" on it, but automatic and
 * driven purely by the blacklist. This is what turns a source added before its domain was
 * blacklisted (e.g. qazcloud.kz itself) into `disabled` without a manual click or a one-off
 * migration: growing EXCLUDED_DOMAINS alone is enough. Idempotent (already-disabled sources are
 * left alone) and never touches mentions already collected from that source.
 */
@Injectable()
export class DomainExclusionEnforcerService implements OnModuleInit {
  private readonly logger = new Logger(DomainExclusionEnforcerService.name);

  constructor(
    private readonly sourcesService: SourcesService,
    private readonly domainExclusionService: DomainExclusionService,
  ) {}

  async onModuleInit(): Promise<void> {
    const sources = await this.sourcesService.findAll();
    for (const source of sources) {
      if (source.status === SourceStatus.DISABLED) {
        continue;
      }
      if (this.domainExclusionService.isUrlExcluded(source.url)) {
        await this.sourcesService.setEnabled(source.id, false);
        this.logger.warn(`Источник ${source.url} отключён — домен в списке исключений (EXCLUDED_DOMAINS)`);
      }
    }
  }
}