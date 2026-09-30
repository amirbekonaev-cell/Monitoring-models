import { Repository } from 'typeorm';
import { CuratedResetService } from './curated-reset.service';
import { CuratedLink, CuratedLinkStatus } from './curated-link.entity';
import { Mention } from '../mentions/mention.entity';

interface Captured {
  deleteWhere: { clause: string; params: unknown } | null;
  updateSet: Record<string, unknown> | null;
}

function makeService(linkIds: string[], mentionCount: number, captured: Captured) {
  const linksRepo = {
    createQueryBuilder: jest.fn(() => ({
      select: () => ({
        where: () => ({ getRawMany: async () => linkIds.map((id) => ({ id })) }),
        getRawMany: async () => linkIds.map((id) => ({ id })),
      }),
      update: () => ({
        set: (values: Record<string, unknown>) => {
          captured.updateSet = values;
          return { where: () => ({ execute: async () => ({ affected: linkIds.length }) }) };
        },
      }),
    })),
  } as unknown as Repository<CuratedLink>;

  const mentionsRepo = {
    createQueryBuilder: jest.fn(() => ({
      where: () => ({ getCount: async () => mentionCount }),
      delete: () => ({
        from: () => ({
          where: (clause: string, params: unknown) => {
            captured.deleteWhere = { clause, params };
            return { execute: async () => ({ affected: mentionCount }) };
          },
        }),
      }),
    })),
  } as unknown as Repository<Mention>;

  return new CuratedResetService(linksRepo, mentionsRepo);
}

describe('CuratedResetService', () => {
  let captured: Captured;

  beforeEach(() => {
    captured = { deleteWhere: null, updateSet: null };
  });

  it('preview() reports what would be lost without touching anything', async () => {
    const service = makeService(['l1', 'l2'], 7, captured);

    await expect(service.preview()).resolves.toEqual({ links: 2, mentions: 7 });

    expect(captured.deleteWhere).toBeNull();
    expect(captured.updateSet).toBeNull();
  });

  it('reset() puts links back to pending, clearing the attempt/error/mention bookkeeping with them', async () => {
    const service = makeService(['l1', 'l2'], 7, captured);

    await expect(service.reset()).resolves.toEqual({ links: 2, mentions: 7, mentionsDeleted: 7 });

    expect(captured.updateSet).toEqual({
      status: CuratedLinkStatus.PENDING,
      attempts: 0,
      lastError: null,
      processedAt: null,
      mentionId: null,
    });
  });

  // The guarantee that makes this safe to expose as a Telegram button: it can only ever delete
  // rows that came from the pool. Everything collected by RSS/parser/"Добавить по ссылке" has
  // curated_link_id NULL and cannot match this WHERE clause.
  it('deletes only mentions tied to the selected pool links, never anything else', async () => {
    const service = makeService(['l1', 'l2'], 7, captured);

    await service.reset();

    expect(captured.deleteWhere?.clause).toBe('curated_link_id IN (:...linkIds)');
    expect(captured.deleteWhere?.params).toEqual({ linkIds: ['l1', 'l2'] });
  });

  it('does nothing at all when no link matches (an empty pool, or an unknown host filter)', async () => {
    const service = makeService([], 0, captured);

    await expect(service.reset(['nosuchhost.kz'])).resolves.toEqual({ links: 0, mentions: 0, mentionsDeleted: 0 });

    expect(captured.deleteWhere).toBeNull();
    expect(captured.updateSet).toBeNull();
  });
});
