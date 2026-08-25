import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { Mention } from './mention.entity';

export interface CreateMentionInput {
  title: string;
  text: string;
  url: string;
  publishedAt: Date | null;
  sourceId: string;
  sourceType: Mention['sourceType'];
  hash: string;
  keywords: string[];
}

export interface FindMentionsQuery {
  limit: number;
  offset: number;
}

/**
 * Both title AND body text must be at or above these trigram similarity levels to be treated
 * as the same story reprinted elsewhere. Title-only matching turned out to be too aggressive
 * in practice: recurring template columns ("Какая погода будет в Казахстане 18 августа" vs
 * "...19 августа", daily military-briefing digests, "what holiday is today") share near-
 * identical titles day to day while being genuinely different articles with different body
 * text — title-only similarity silently swallowed them as fake reprints. Real reprints/copies
 * carry over the article body close to verbatim, so requiring text similarity too tells the
 * two cases apart.
 */
const REPRINT_TITLE_SIMILARITY_THRESHOLD = 0.6;
const REPRINT_TEXT_SIMILARITY_THRESHOLD = 0.5;

export type CreateMentionResult = 'inserted' | 'reprint' | 'duplicate';

@Injectable()
export class MentionsService {
  private readonly logger = new Logger(MentionsService.name);

  constructor(
    @InjectRepository(Mention)
    private readonly mentionsRepo: Repository<Mention>,
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Inserts a mention if it's genuinely new. If it's an exact hash duplicate or a
   * near-duplicate title (pg_trgm similarity) of an existing mention, records it as a
   * reprint on the existing card instead of creating a new row.
   */
  async createIfNew(input: CreateMentionInput): Promise<CreateMentionResult> {
    const existingByHash = await this.mentionsRepo.findOne({ where: { hash: input.hash } });
    if (existingByHash) {
      await this.addReprintIfNewUrl(existingByHash, input);
      return 'duplicate';
    }

    const similar = await this.findSimilarByContent(input.title, input.text, input.publishedAt);
    if (similar) {
      await this.addReprintIfNewUrl(similar, input);
      return 'reprint';
    }

    const result = await this.mentionsRepo
      .createQueryBuilder()
      .insert()
      .into(Mention)
      .values({
        title: input.title,
        text: input.text,
        url: input.url,
        publishedAt: input.publishedAt,
        sourceId: input.sourceId,
        sourceType: input.sourceType,
        hash: input.hash,
        keywords: input.keywords,
        reprints: [],
      })
      .orIgnore()
      .execute();

    return (result.identifiers?.length ?? 0) > 0 ? 'inserted' : 'duplicate';
  }

  private async findSimilarByContent(title: string, text: string, publishedAt: Date | null): Promise<Mention | null> {
    // Window the comparison to nearby publish dates so we don't chase similarity across
    // the whole table, and so two unrelated stories that happen to share generic wording
    // months apart don't get merged.
    const windowStart = publishedAt ? new Date(publishedAt.getTime() - 5 * 24 * 60 * 60 * 1000) : null;
    const windowEnd = publishedAt ? new Date(publishedAt.getTime() + 5 * 24 * 60 * 60 * 1000) : null;

    // No body text to compare (some channels only surface a title) — fall back to a much
    // stricter title-only bar so a bare-title item still can't casually match a template.
    if (!text.trim()) {
      const rows = await this.dataSource.query(
        `SELECT id FROM mentions
         WHERE similarity(title, $1) > 0.9
           AND ($2::timestamptz IS NULL OR published_at IS NULL OR published_at BETWEEN $2 AND $3)
         ORDER BY similarity(title, $1) DESC
         LIMIT 1`,
        [title, windowStart, windowEnd],
      );
      return rows.length > 0 ? this.mentionsRepo.findOne({ where: { id: rows[0].id } }) : null;
    }

    const rows = await this.dataSource.query(
      `SELECT id, similarity(title, $1) as title_sim, similarity(text, $2) as text_sim
       FROM mentions
       WHERE similarity(title, $1) > $3
         AND similarity(text, $2) > $4
         AND ($5::timestamptz IS NULL OR published_at IS NULL OR published_at BETWEEN $5 AND $6)
       ORDER BY (similarity(title, $1) + similarity(text, $2)) DESC
       LIMIT 1`,
      [
        title,
        text,
        REPRINT_TITLE_SIMILARITY_THRESHOLD,
        REPRINT_TEXT_SIMILARITY_THRESHOLD,
        windowStart,
        windowEnd,
      ],
    );

    if (rows.length === 0) {
      return null;
    }
    return this.mentionsRepo.findOne({ where: { id: rows[0].id } });
  }

  private async addReprintIfNewUrl(existing: Mention, input: CreateMentionInput): Promise<void> {
    if (existing.url === input.url) {
      return;
    }
    const alreadyRecorded = existing.reprints?.some((r) => r.url === input.url);
    if (alreadyRecorded) {
      return;
    }
    const reprints = [
      ...(existing.reprints ?? []),
      { url: input.url, sourceId: input.sourceId, foundAt: new Date().toISOString() },
    ];
    await this.mentionsRepo.update(existing.id, { reprints });
    this.logger.log(`Reprint recorded on mention ${existing.id}: ${input.url}`);
  }

  async findRecent(query: FindMentionsQuery): Promise<{ items: Mention[]; total: number }> {
    const [items, total] = await this.mentionsRepo.findAndCount({
      order: { publishedAt: 'DESC', foundAt: 'DESC' },
      take: query.limit,
      skip: query.offset,
    });
    return { items, total };
  }

  async countBySource(sourceId: string): Promise<number> {
    return this.mentionsRepo.count({ where: { sourceId } });
  }
}
