import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Not, Repository } from 'typeorm';
import { Source, SourceKind, SourceStatus } from './source.entity';

@Injectable()
export class SourcesService {
  constructor(
    @InjectRepository(Source)
    private readonly sourcesRepo: Repository<Source>,
  ) {}

  /**
   * Sources to poll on the next cycle: everything except explicitly disabled. `error` is
   * included on purpose — it's a status report ("last attempt failed"), not a kill switch.
   * A source that failed once (timeout, transient DNS hiccup) must keep being retried on
   * schedule automatically; only an admin disabling it should stop that.
   */
  findActiveByType(type: SourceKind): Promise<Source[]> {
    return this.sourcesRepo.find({ where: { type, status: Not(SourceStatus.DISABLED) } });
  }

  findAll(): Promise<Source[]> {
    return this.sourcesRepo.find({ order: { createdAt: 'DESC' } });
  }

  findByUrl(url: string): Promise<Source | null> {
    return this.sourcesRepo.findOne({ where: { url } });
  }

  findById(id: string): Promise<Source | null> {
    return this.sourcesRepo.findOne({ where: { id } });
  }

  create(params: { url: string; name: string | null; type: SourceKind; createdBy: string }): Promise<Source> {
    return this.sourcesRepo.save(
      this.sourcesRepo.create({
        url: params.url,
        name: params.name,
        type: params.type,
        status: SourceStatus.ACTIVE,
        createdBy: params.createdBy,
      }),
    );
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    await this.sourcesRepo.update(id, { status: enabled ? SourceStatus.ACTIVE : SourceStatus.DISABLED });
  }

  /** Old mentions stay in the DB — deleting a source only removes it from the registry. */
  async remove(id: string): Promise<void> {
    await this.sourcesRepo.delete(id);
  }

  async markSuccess(id: string): Promise<void> {
    await this.sourcesRepo.update(id, {
      status: SourceStatus.ACTIVE,
      lastSuccessAt: new Date(),
      lastError: null,
    });
  }

  async markError(id: string, message: string): Promise<void> {
    await this.sourcesRepo.update(id, {
      status: SourceStatus.ERROR,
      lastError: message,
    });
  }

  /** Records that the sitemap/HTML-pagination deep pass just completed — see fetchRssWithDeepScan. */
  async markDeepScanDone(id: string): Promise<void> {
    await this.sourcesRepo.update(id, { lastDeepScanAt: new Date() });
  }

  /**
   * Some channels (К-1 search API) aren't "one row per link" like RSS/Telegram/parser —
   * there's one global search config. This makes sure exactly one such source row exists
   * so it still shows up in the sources list with a normal status/last-success/error.
   */
  async ensureSingleton(params: { url: string; name: string; type: SourceKind }): Promise<Source> {
    const existing = await this.sourcesRepo.findOne({ where: { url: params.url } });
    if (existing) {
      return existing;
    }
    return this.sourcesRepo.save(
      this.sourcesRepo.create({
        url: params.url,
        name: params.name,
        type: params.type,
        status: SourceStatus.ACTIVE,
        createdBy: 'system',
      }),
    );
  }
}