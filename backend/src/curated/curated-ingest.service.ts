import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash } from 'crypto';
import { LessThan, Repository } from 'typeorm';
import { ParserService } from '../collectors/parser/parser.service';
import { ActiveKeywordSet, KeywordsService } from '../keywords/keywords.service';
import { Keyword, KeywordType } from '../keywords/keyword.entity';
import { MentionSourceType, Sentiment } from '../mentions/mention.entity';
import { MentionsService } from '../mentions/mentions.service';
import { SourcesService } from '../sources/sources.service';
import { SourceKind } from '../sources/source.entity';
import { CURATED_SOURCE_NAME, CURATED_SOURCE_URL } from './curated-source-bootstrap.service';
import { CuratedLink, CuratedLinkDateSource, CuratedLinkStatus } from './curated-link.entity';
import { CuratedOpenAiReaderService } from './curated-openai-reader.service';
import { buildMentionContext } from './curated-context.util';
import { extractDateFromUrl, parseIsoDate, resolveArticleDate } from './curated-article-date.util';
import { curatedLinkRef } from './curated-url.util';
import { HostQueue, runWithConcurrency } from './host-queue.util';

/** How the page's text was actually obtained — reported per link and tallied per run. */
export type CuratedReadVia = 'parser' | 'openai';

export interface ProcessLinkOutcome {
  linkId: string;
  /** The status the link ended up in. `pending` means "try again later" (timeout / transient). */
  status: CuratedLinkStatus;
  readVia: CuratedReadVia | null;
  webSearchCalls: number;
  sentimentCalls: number;
  sentiment: Sentiment | null;
  dateSource: CuratedLinkDateSource | null;
  mentionId: string | null;
  /** Human-readable, host-level at most — never contains the link's URL. */
  error: string | null;
}

export interface ProcessRunSummary {
  attempted: number;
  readByParser: number;
  readByOpenAi: number;
  webSearchCalls: number;
  sentimentCalls: number;
  byStatus: Record<CuratedLinkStatus, number>;
  bySentiment: Record<Sentiment, number>;
  withDate: number;
  withoutDate: number;
  byDateSource: Record<string, number>;
}

export interface ProcessOptions {
  limit?: number;
  concurrency?: number;
  /** Re-process links already marked processed (costs another OpenAI call each — off by default). */
  force?: boolean;
  /** Include links already given up on (status `failed`), resetting their attempt counter. */
  retryFailed?: boolean;
  /** Wall-clock stop (Date.now() ms). No NEW link is started past it; running ones finish. */
  deadline?: number;
  /** Restrict the batch to these hosts — used to re-run just the links a diagnosis fixed. */
  hosts?: string[];
  onProgress?: (done: number, total: number, outcome: ProcessLinkOutcome) => void;
}

/** Shared per-run context, loaded once instead of per link (same idea as ActiveKeywordSet). */
interface IngestContext {
  keywordSet: ActiveKeywordSet;
  /** Literal spellings of the company name — for context extraction and for the model prompt. */
  companyForms: string[];
  sourceId: string;
  hostQueue: HostQueue;
}

/**
 * Fills the closed pool: reads each `curated_links` row's page, decides whether the company is
 * actually mentioned, extracts the passage around the mention, dates it, classifies its tone and
 * writes the resulting `mentions` row — the write side of the feature whose read side is
 * CuratedSearchService (ПРОМПТ 1).
 *
 * Three constraints shape the whole class:
 *
 *  - **Money.** Every OpenAI page read is billed, so a link that is already `processed` is never
 *    read again without `--force`, and the free HTTP parser is always tried first in `auto` mode.
 *  - **Privacy.** No method here logs `link.url`; everything goes through curatedLinkRef() (id +
 *    host). Mentions are inserted with `urlHidden: true` and `skipDedup: true` — see
 *    mention-privacy.util.ts and MentionsService.insertOrDedup for why both are required.
 *  - **Isolation.** One failing link never stops the run. Every failure becomes `attempts + 1`
 *    plus a readable `last_error` on that one row, and the pass continues.
 */
@Injectable()
export class CuratedIngestService {
  private readonly logger = new Logger(CuratedIngestService.name);

  constructor(
    @InjectRepository(CuratedLink)
    private readonly linksRepo: Repository<CuratedLink>,
    private readonly config: ConfigService,
    private readonly parser: ParserService,
    private readonly openAiReader: CuratedOpenAiReaderService,
    private readonly keywordsService: KeywordsService,
    private readonly mentionsService: MentionsService,
    private readonly sourcesService: SourcesService,
  ) {}

  private num(key: string, fallback: number): number {
    const value = this.config.get<number>(`curated.${key}`);
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  }

  get maxAttempts(): number {
    return this.num('maxAttempts', 3);
  }

  private get readMode(): 'auto' | 'openai' {
    return this.config.get<string>('curated.readMode') === 'openai' ? 'openai' : 'auto';
  }

  /**
   * Processes a batch of links. Selection order is `created_at ASC` so a resumed run continues
   * roughly where the previous one stopped rather than re-shuffling the pool.
   */
  async processPending(options: ProcessOptions = {}): Promise<ProcessRunSummary> {
    const links = await this.selectLinks(options);
    const summary = emptySummary();

    if (links.length === 0) {
      return summary;
    }

    // --force / --retry-failed mean "give these another real chance", so the attempt counter is
    // cleared up front — otherwise a link already at CURATED_MAX_ATTEMPTS would be marked failed
    // again on its very first try of this run.
    if (options.force || options.retryFailed) {
      await this.linksRepo.update(
        links.map((l) => l.id),
        { attempts: 0, lastError: null },
      );
      links.forEach((link) => {
        link.attempts = 0;
      });
    }

    const context = await this.buildContext();
    let done = 0;

    await runWithConcurrency(links, options.concurrency ?? this.num('concurrency', 4), async (link) => {
      if (options.deadline !== undefined && Date.now() >= options.deadline) {
        return;
      }
      const outcome = await context.hostQueue.run(link.host ?? 'unknown', () => this.processLink(link, context));
      done += 1;
      tally(summary, outcome);
      options.onProgress?.(done, links.length, outcome);
    });

    return summary;
  }

  /** The links a run would touch, given its options — also used by the scripts to report totals. */
  async selectLinks(options: ProcessOptions = {}): Promise<CuratedLink[]> {
    const statuses: CuratedLinkStatus[] = [CuratedLinkStatus.PENDING];
    if (options.force) {
      statuses.push(CuratedLinkStatus.PROCESSED, CuratedLinkStatus.NOT_RELEVANT, CuratedLinkStatus.FAILED);
    }
    if (options.retryFailed) {
      statuses.push(CuratedLinkStatus.FAILED);
    }

    const qb = this.linksRepo
      .createQueryBuilder('c')
      .where('c.status IN (:...statuses)', { statuses: [...new Set(statuses)] })
      .orderBy('c.createdAt', 'ASC');

    // `excluded` links are never selected at all (they are in EXCLUDED_DOMAINS); a `pending` link
    // that already burned through its attempts is skipped unless --retry-failed/--force says so.
    if (!options.force && !options.retryFailed) {
      qb.andWhere('c.attempts < :maxAttempts', { maxAttempts: this.maxAttempts });
    }
    if (options.hosts?.length) {
      qb.andWhere('c.host IN (:...hosts)', { hosts: options.hosts });
    }
    if (options.limit) {
      qb.take(options.limit);
    }

    return qb.getMany();
  }

  /**
   * Links the lazy /search pass may pick up: pending, or failed-but-retryable. Ordered oldest
   * first for the same "resume where we left off" reason as selectLinks().
   */
  async findLazyCandidates(limit: number): Promise<CuratedLink[]> {
    return this.linksRepo.find({
      where: [
        { status: CuratedLinkStatus.PENDING, attempts: LessThan(this.maxAttempts) },
        { status: CuratedLinkStatus.FAILED, attempts: LessThan(this.maxAttempts) },
      ],
      order: { createdAt: 'ASC' },
      take: limit,
    });
  }

  async countByStatus(): Promise<Record<string, number>> {
    const rows = await this.linksRepo
      .createQueryBuilder('c')
      .select('c.status', 'status')
      .addSelect('COUNT(*)', 'count')
      .groupBy('c.status')
      .getRawMany<{ status: string; count: string }>();
    return Object.fromEntries(rows.map((r) => [r.status, parseInt(r.count, 10)]));
  }

  async buildContext(): Promise<IngestContext> {
    // includeMinus: false — see KeywordsService.loadActiveKeywordSet. The pool is hand-vetted,
    // so a minus keyword here rejects a link a person deliberately added rather than filtering
    // noise. Positive matching is unchanged and still decides relevance.
    const keywordSet = await this.keywordsService.loadActiveKeywordSet({ includeMinus: false });
    const source = await this.sourcesService.ensureSingleton({
      url: CURATED_SOURCE_URL,
      name: CURATED_SOURCE_NAME,
      type: SourceKind.CURATED,
    });
    return {
      keywordSet,
      companyForms: await this.loadCompanyForms(),
      sourceId: source.id,
      hostQueue: new HostQueue(this.num('hostDelayMs', 300)),
    };
  }

  /**
   * Literal spellings of the company name, from the active required/exact_phrase keywords plus
   * their manual forms. Used for two things that Postgres FTS cannot do: finding the *position*
   * of a mention inside the article text (curated-context.util.ts), and telling the model which
   * strings to look for. Keyword matching itself still goes through ActiveKeywordSet, unchanged.
   */
  private async loadCompanyForms(): Promise<string[]> {
    const keywords: Keyword[] = await this.keywordsService.findAll();
    const forms = keywords
      .filter((k) => k.isActive && (k.type === KeywordType.REQUIRED || k.type === KeywordType.EXACT_PHRASE))
      .flatMap((k) => [k.phrase, ...(k.manualForms ?? [])])
      .map((f) => f.trim())
      .filter(Boolean);
    return [...new Set(forms)];
  }

  /**
   * One link, end to end. Never throws: every failure path ends in a row update and a returned
   * outcome, because the caller is processing 169 of these and must not lose the other 168 to
   * one dead host.
   */
  async processLink(link: CuratedLink, context: IngestContext): Promise<ProcessLinkOutcome> {
    const ref = curatedLinkRef(link.id, link.host);
    const timeoutMs = this.num('linkTimeoutMs', 25000);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const base: ProcessLinkOutcome = {
      linkId: link.id,
      status: CuratedLinkStatus.PENDING,
      readVia: null,
      webSearchCalls: 0,
      sentimentCalls: 0,
      sentiment: null,
      dateSource: null,
      mentionId: null,
      error: null,
    };

    try {
      const read = await this.readPage(link, context, controller.signal);
      base.readVia = read.readVia;
      base.webSearchCalls = read.webSearchCalls;

      if (!read.title && !read.text) {
        return await this.recordFailure(link, base, 'страница не открылась или не содержит текста', ref);
      }

      const relevance = await this.checkRelevance(read, context);
      if (!relevance.relevant) {
        return await this.recordNotRelevant(link, base, relevance.reason, ref);
      }

      const text = buildMentionContext(read.title ?? '', read.text, context.companyForms);

      const { date, source: dateSource } = resolveArticleDate({
        fromPage: read.pageDate,
        fromUrl: extractDateFromUrl(link.url),
        fromModel: parseIsoDate(read.modelDateIso),
      });
      base.dateSource = dateSource;

      const title = read.title || (link.groupLabel ?? 'Материал из пула');
      // group_label from the file, NOT the domain — the label is what /search prints, and a
      // domain there would reconstruct half the hidden link for the reader.
      const sourceLabel = link.groupLabel ?? CURATED_SOURCE_NAME;

      // A re-run (`--force`) must UPDATE the mention this link already produced, not insert a
      // second one: pool inserts use skipDedup, and the partial UNIQUE index on curated_link_id
      // would silently drop the second row — leaving the stale content in place. This is the
      // path that lets a fixed date extractor actually reach the existing mentions.
      const existingMentionId = link.mentionId ?? (await this.findMentionIdFor(link.id));

      if (existingMentionId) {
        await this.mentionsService.updateCuratedContent(existingMentionId, {
          title,
          text,
          publishedAt: date,
          sourceLabel,
          keywords: relevance.matchedKeywords,
        });
        const existing = await this.mentionsService.findById(existingMentionId);
        base.sentiment = existing?.sentiment ?? Sentiment.UNDEFINED;
        // Only pay for classification again if the mention never got a tone in the first place
        // (e.g. it was first processed with no OPENAI_API_KEY configured).
        if (base.sentiment === Sentiment.UNDEFINED) {
          await this.mentionsService.classifyExisting(existingMentionId);
          base.sentimentCalls = 1;
          base.sentiment = (await this.mentionsService.findById(existingMentionId))?.sentiment ?? Sentiment.UNDEFINED;
        }
      } else {
        const insert = await this.mentionsService.createIfNewAndClassify({
          title,
          text,
          url: link.url,
          publishedAt: date,
          sourceId: context.sourceId,
          sourceType: MentionSourceType.NEWS,
          sourceLabel,
          hash: curatedMentionHash(link.urlHash),
          keywords: relevance.matchedKeywords,
          skipDedup: true,
          urlHidden: true,
          curatedLinkId: link.id,
        });
        base.sentimentCalls = 1;
        base.sentiment = insert.sentiment;
      }

      const mention = existingMentionId ?? (await this.findMentionIdFor(link.id));
      base.mentionId = mention;
      base.status = CuratedLinkStatus.PROCESSED;

      await this.linksRepo.update(link.id, {
        status: CuratedLinkStatus.PROCESSED,
        attempts: link.attempts + 1,
        lastError: null,
        dateSource,
        mentionId: mention,
        lastAttemptAt: new Date(),
        processedAt: new Date(),
      });

      this.logger.log(
        `${ref}: обработана (${read.readVia}), тональность=${base.sentiment}, дата=${dateSource ?? 'нет'}`,
      );
      return base;
    } catch (error) {
      const aborted = controller.signal.aborted;
      const message = aborted
        ? `таймаут ${timeoutMs} мс на обработку ссылки`
        : humanizeError(error, link.host ?? 'unknown');
      // A timeout leaves the link PENDING (with attempts + 1) rather than failing it outright:
      // it says nothing about whether the page is readable, only that this attempt ran long.
      return await this.recordFailure(link, base, message, ref);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * `auto`: the free HTTP parser first, OpenAI only when it came back with nothing usable — a
   * throw (404/403/network), no title, or a body shorter than `minPageTextChars`, which is what
   * an anti-bot interstitial or a JS-rendered shell looks like from here.
   * `openai`: straight to the model, no HTTP attempt.
   */
  private async readPage(
    link: CuratedLink,
    context: IngestContext,
    signal: AbortSignal,
  ): Promise<{
    readVia: CuratedReadVia;
    title: string | null;
    text: string;
    pageDate: Date | null;
    modelDateIso: string | null;
    modelSaysMentioned: boolean;
    modelFragments: string[];
    webSearchCalls: number;
  }> {
    const ref = curatedLinkRef(link.id, link.host);

    if (this.readMode === 'auto') {
      let parserError: string | null = null;
      // Both spellings of the path. Normalization strips a trailing slash (see
      // curated-url.util.ts), and a few sites treat the two as different resources — sk.kz
      // answers 404 for `/news/56084` and 200 for `/news/56084/`. Retrying with the slash costs
      // one free HTTP request and saves a billed OpenAI read, so it happens before the fallback,
      // not instead of it.
      for (const candidateUrl of withTrailingSlashVariant(link.url)) {
        try {
          const page = await this.parser.fetchPageDetailed(candidateUrl, signal);
          const minChars = this.num('minPageTextChars', 400);
          if (page.title && page.text.trim().length >= minChars) {
            return {
              readVia: 'parser',
              title: page.title,
              text: page.text,
              pageDate: page.publishedAt,
              modelDateIso: null,
              modelSaysMentioned: false,
              modelFragments: [],
              webSearchCalls: 0,
            };
          }
          parserError = `парсер получил ${page.text.trim().length} символов текста (порог ${minChars})`;
        } catch (error) {
          if (signal.aborted) {
            throw error;
          }
          parserError = humanizeError(error, link.host ?? 'unknown');
        }
      }
      this.logger.debug(`${ref}: парсер не справился (${parserError}) — пробую OpenAI`);
    }

    const read = await this.openAiReader.readPage(link.url, context.companyForms, signal);
    return {
      readVia: 'openai',
      title: read.title,
      text: read.fragments.join('\n\n'),
      pageDate: null,
      modelDateIso: read.publishedAtIso,
      modelSaysMentioned: read.mentionsCompany,
      modelFragments: read.fragments,
      webSearchCalls: read.webSearchCalls,
    };
  }

  /**
   * Relevance is decided by the same ActiveKeywordSet every other channel uses — including its
   * minus-keyword veto. The model's own `mentions_company` flag is only ever an ADDITIONAL way
   * in, and only in the OpenAI read path: it is re-checked by running the keyword matcher over
   * the fragments the model returned, so a model that claims a mention it cannot quote does not
   * get to create one, and a minus keyword still blocks the item either way.
   */
  private async checkRelevance(
    read: { title: string | null; text: string; modelSaysMentioned: boolean; modelFragments: string[] },
    context: IngestContext,
  ): Promise<{ relevant: boolean; matchedKeywords: string[]; reason: string }> {
    const primary = await context.keywordSet.match(read.title ?? '', read.text);
    if (primary.matched) {
      return { relevant: true, matchedKeywords: primary.matchedKeywords, reason: '' };
    }

    if (read.modelSaysMentioned && read.modelFragments.length > 0) {
      const viaFragments = await context.keywordSet.match(read.title ?? '', read.modelFragments.join('\n'));
      if (viaFragments.matched) {
        return { relevant: true, matchedKeywords: viaFragments.matchedKeywords, reason: '' };
      }
      return {
        relevant: false,
        matchedKeywords: [],
        reason: 'модель сообщила об упоминании, но в приведённых фрагментах ключевых слов нет',
      };
    }

    return { relevant: false, matchedKeywords: [], reason: 'на странице нет активных ключевых слов компании' };
  }

  private async recordNotRelevant(
    link: CuratedLink,
    base: ProcessLinkOutcome,
    reason: string,
    ref: string,
  ): Promise<ProcessLinkOutcome> {
    await this.linksRepo.update(link.id, {
      status: CuratedLinkStatus.NOT_RELEVANT,
      attempts: link.attempts + 1,
      lastError: reason,
      lastAttemptAt: new Date(),
      processedAt: new Date(),
    });
    this.logger.log(`${ref}: не релевантна — ${reason}`);
    return { ...base, status: CuratedLinkStatus.NOT_RELEVANT, error: reason };
  }

  private async recordFailure(
    link: CuratedLink,
    base: ProcessLinkOutcome,
    message: string,
    ref: string,
  ): Promise<ProcessLinkOutcome> {
    const attempts = link.attempts + 1;
    // A link stays `pending` (retryable) until its attempts are spent — a timeout or a transient
    // network error says nothing about whether the page is readable, only that this try wasn't.
    // `failed` is reserved for "we tried CURATED_MAX_ATTEMPTS times and it never worked".
    const status = attempts >= this.maxAttempts ? CuratedLinkStatus.FAILED : CuratedLinkStatus.PENDING;

    await this.linksRepo.update(link.id, {
      status,
      attempts,
      lastError: message,
      lastAttemptAt: new Date(),
    });
    this.logger.warn(`${ref}: попытка ${attempts}/${this.maxAttempts} не удалась — ${message}`);
    return { ...base, status, error: message };
  }

  private async findMentionIdFor(linkId: string): Promise<string | null> {
    const row = await this.linksRepo.manager.query('SELECT id FROM mentions WHERE curated_link_id = $1 LIMIT 1', [
      linkId,
    ]);
    return row?.[0]?.id ?? null;
  }
}

/**
 * `sha256('curated:' + url_hash)` — stable per link and distinct from hashMentionText()'s
 * title/text digest, so re-processing the same link cannot produce a second row that looks
 * unrelated. (MentionsService re-hashes it once more with a random component because
 * `skipDedup` inserts must not collide on the UNIQUE hash column — see insertOrDedup.)
 */
export function curatedMentionHash(urlHash: string): string {
  return createHash('sha256').update(`curated:${urlHash}`).digest('hex');
}

/**
 * The URL, then the same URL with a trailing slash added (or nothing more, when it already has
 * one or has no path to speak of). Used to work around sites that serve a path and that path
 * plus "/" as different resources — see readPage().
 */
export function withTrailingSlashVariant(url: string): string[] {
  try {
    const parsed = new URL(url);
    if (parsed.pathname.length <= 1 || parsed.pathname.endsWith('/')) {
      return [url];
    }
    parsed.pathname = `${parsed.pathname}/`;
    return [url, parsed.toString()];
  } catch {
    return [url];
  }
}

/** Error text fit for `last_error`: readable, and never carrying the link's URL. */
export function humanizeError(error: unknown, host: string): string {
  const raw = error instanceof Error ? error.message : String(error);
  const withoutUrls = raw.replace(/https?:\/\/\S+/gi, `<ссылка ${host}>`);
  if (/HTTP 404/.test(withoutUrls)) {
    return `страница недоступна: HTTP 404 (${host})`;
  }
  if (/HTTP 40[13]/.test(withoutUrls)) {
    return `доступ к странице закрыт (${host})`;
  }
  if (/abort|timeout/i.test(withoutUrls)) {
    return `превышено время ожидания (${host})`;
  }
  return withoutUrls.slice(0, 500);
}

function emptySummary(): ProcessRunSummary {
  return {
    attempted: 0,
    readByParser: 0,
    readByOpenAi: 0,
    webSearchCalls: 0,
    sentimentCalls: 0,
    byStatus: Object.values(CuratedLinkStatus).reduce(
      (acc, s) => ({ ...acc, [s]: 0 }),
      {} as Record<CuratedLinkStatus, number>,
    ),
    bySentiment: Object.values(Sentiment).reduce((acc, s) => ({ ...acc, [s]: 0 }), {} as Record<Sentiment, number>),
    withDate: 0,
    withoutDate: 0,
    byDateSource: { page: 0, url: 0, model: 0 },
  };
}

function tally(summary: ProcessRunSummary, outcome: ProcessLinkOutcome | undefined): void {
  if (!outcome) {
    return;
  }
  summary.attempted += 1;
  summary.byStatus[outcome.status] += 1;
  summary.webSearchCalls += outcome.webSearchCalls;
  summary.sentimentCalls += outcome.sentimentCalls;
  if (outcome.readVia === 'parser') summary.readByParser += 1;
  if (outcome.readVia === 'openai') summary.readByOpenAi += 1;
  if (outcome.sentiment) summary.bySentiment[outcome.sentiment] += 1;
  if (outcome.status === CuratedLinkStatus.PROCESSED) {
    if (outcome.dateSource) {
      summary.withDate += 1;
      summary.byDateSource[outcome.dateSource] += 1;
    } else {
      summary.withoutDate += 1;
    }
  }
}
