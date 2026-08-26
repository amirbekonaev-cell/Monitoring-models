import { Not, Repository } from 'typeorm';
import { SourcesService } from './sources.service';
import { Source, SourceKind, SourceStatus } from './source.entity';

describe('SourcesService.findActiveByType', () => {
  it('polls active AND error sources, but excludes disabled ones', async () => {
    const repo = { find: jest.fn(async () => [] as Source[]) } as unknown as Repository<Source>;
    const service = new SourcesService(repo);

    await service.findActiveByType(SourceKind.RSS);

    // A source that failed once (timeout, transient DNS blip) must still be retried on the
    // next scheduled cycle automatically — `error` is a status report, not a kill switch.
    // Only an admin explicitly disabling a source should stop it from being polled.
    expect(repo.find).toHaveBeenCalledWith({
      where: { type: SourceKind.RSS, status: Not(SourceStatus.DISABLED) },
    });
  });
});

describe('SourcesService.markDeepScanDone', () => {
  it('stamps last_deep_scan_at with the current time, separately from last_success_at', async () => {
    const repo = { update: jest.fn(async () => undefined) } as unknown as Repository<Source>;
    const service = new SourcesService(repo);

    await service.markDeepScanDone('src-1');

    expect(repo.update).toHaveBeenCalledWith('src-1', { lastDeepScanAt: expect.any(Date) });
  });
});