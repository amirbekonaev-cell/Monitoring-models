import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Mention } from '../mentions/mention.entity';
import { CuratedLink, CuratedLinkStatus } from './curated-link.entity';

export interface CuratedResetPreview {
  links: number;
  mentions: number;
}

export interface CuratedResetOutcome extends CuratedResetPreview {
  mentionsDeleted: number;
}

/**
 * Puts the closed pool back to its un-processed state: every selected link to `pending`, and the
 * mentions those links produced deleted. The link list itself (URLs, hosts, group labels) is left
 * untouched, so the next pass — `curated:process`, or the bot's own CURATED_LAZY_PROCESS top-up —
 * reads them again from scratch.
 *
 * Shared by the CLI script (scripts/curated-reset.ts) and the bot's /reset button on purpose:
 * one destructive operation with two front doors must not be implemented twice, or the two will
 * drift on exactly the detail that matters (which rows count as "pool" rows).
 *
 * DESTRUCTIVE, and in two ways worth naming separately:
 *  - deleted mentions take their already-classified tone with them, INCLUDING a manual correction
 *    made in the UI (`sentiment_manual` does not survive the row being deleted);
 *  - re-processing re-downloads every page and pays for classification again.
 * Neither caller may run this without an explicit confirmation from the person asking.
 */
@Injectable()
export class CuratedResetService {
  private readonly logger = new Logger(CuratedResetService.name);

  constructor(
    @InjectRepository(CuratedLink)
    private readonly linksRepo: Repository<CuratedLink>,
    @InjectRepository(Mention)
    private readonly mentionsRepo: Repository<Mention>,
  ) {}

  /** What reset() would do, without doing it — for the confirmation prompt on either front door. */
  async preview(hosts?: string[]): Promise<CuratedResetPreview> {
    const linkIds = await this.selectLinkIds(hosts);
    if (linkIds.length === 0) {
      return { links: 0, mentions: 0 };
    }
    const mentions = await this.mentionsRepo
      .createQueryBuilder('m')
      .where('m.curatedLinkId IN (:...linkIds)', { linkIds })
      .getCount();
    return { links: linkIds.length, mentions };
  }

  async reset(hosts?: string[]): Promise<CuratedResetOutcome> {
    const linkIds = await this.selectLinkIds(hosts);
    if (linkIds.length === 0) {
      return { links: 0, mentions: 0, mentionsDeleted: 0 };
    }

    const mentions = await this.mentionsRepo
      .createQueryBuilder('m')
      .where('m.curatedLinkId IN (:...linkIds)', { linkIds })
      .getCount();

    // Mentions first: a link flipped to `pending` while its mention still exists would be
    // re-processed down CuratedIngestService's "refresh the existing mention" branch instead of a
    // clean insert, which is not what a reset should mean.
    const deleted = await this.mentionsRepo
      .createQueryBuilder()
      .delete()
      .from(Mention)
      // curated_link_id IS NOT NULL by construction here (these ids come from curated_links), so
      // nothing collected by RSS/parser/onboarding can be caught by this delete.
      .where('curated_link_id IN (:...linkIds)', { linkIds })
      .execute();

    await this.linksRepo
      .createQueryBuilder()
      .update(CuratedLink)
      .set({
        status: CuratedLinkStatus.PENDING,
        attempts: 0,
        lastError: null,
        processedAt: null,
        mentionId: null,
      })
      .where('id IN (:...linkIds)', { linkIds })
      .execute();

    const mentionsDeleted = deleted.affected ?? 0;
    this.logger.warn(
      `Пул сброшен: ссылок возвращено в pending — ${linkIds.length}, удалено упоминаний — ${mentionsDeleted}` +
        (hosts?.length ? ` (только хосты: ${hosts.join(', ')})` : ' (весь пул)'),
    );
    return { links: linkIds.length, mentions, mentionsDeleted };
  }

  private async selectLinkIds(hosts?: string[]): Promise<string[]> {
    const query = this.linksRepo.createQueryBuilder('c').select('c.id', 'id');
    if (hosts?.length) {
      query.where('c.host IN (:...hosts)', { hosts });
    }
    const rows = await query.getRawMany<{ id: string }>();
    return rows.map((row) => row.id);
  }
}
