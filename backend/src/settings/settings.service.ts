import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Setting } from './setting.entity';

const COLLECTION_ENABLED_KEY = 'collection_enabled';

/**
 * Global on/off switch for all collection channels, persisted in the DB (table `settings`) —
 * not just an in-process boolean — so a backend restart/redeploy after /pause doesn't silently
 * un-pause collection. Missing row (shouldn't normally happen after the migration seeds it)
 * defaults to enabled, matching "по умолчанию collection_enabled = true".
 */
@Injectable()
export class SettingsService {
  constructor(
    @InjectRepository(Setting)
    private readonly settingsRepo: Repository<Setting>,
  ) {}

  async isCollectionEnabled(): Promise<boolean> {
    const row = await this.settingsRepo.findOne({ where: { key: COLLECTION_ENABLED_KEY } });
    return row ? row.value === 'true' : true;
  }

  async setCollectionEnabled(enabled: boolean): Promise<void> {
    await this.settingsRepo.upsert({ key: COLLECTION_ENABLED_KEY, value: enabled ? 'true' : 'false' }, ['key']);
  }
}