import { Repository } from 'typeorm';
import { SettingsService } from './settings.service';
import { Setting } from './setting.entity';

describe('SettingsService', () => {
  it('defaults to enabled when the row is missing (e.g. before the migration/seed ran)', async () => {
    const repo = { findOne: jest.fn(async () => null) } as unknown as Repository<Setting>;
    const service = new SettingsService(repo);

    expect(await service.isCollectionEnabled()).toBe(true);
  });

  it('reflects the stored value once set', async () => {
    const repo = {
      findOne: jest.fn(async () => ({ key: 'collection_enabled', value: 'false', updatedAt: new Date() })),
    } as unknown as Repository<Setting>;
    const service = new SettingsService(repo);

    expect(await service.isCollectionEnabled()).toBe(false);
  });

  it('setCollectionEnabled upserts by key so the flag survives a restart (persisted, not in-memory)', async () => {
    const repo = { upsert: jest.fn(async () => undefined) } as unknown as Repository<Setting>;
    const service = new SettingsService(repo);

    await service.setCollectionEnabled(false);

    expect(repo.upsert).toHaveBeenCalledWith({ key: 'collection_enabled', value: 'false' }, ['key']);

    await service.setCollectionEnabled(true);
    expect(repo.upsert).toHaveBeenCalledWith({ key: 'collection_enabled', value: 'true' }, ['key']);
  });
});