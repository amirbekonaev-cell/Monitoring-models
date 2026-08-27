import { Injectable, Logger } from '@nestjs/common';
import { SourcesService } from '../sources/sources.service';
import { MentionsService } from '../mentions/mentions.service';
import { KeywordsService } from '../keywords/keywords.service';
import { RssService } from '../collectors/rss/rss.service';
import { ParserService } from '../collectors/parser/parser.service';
import { NewsApiService } from '../collectors/search-api/newsapi.service';
import { TelegramService } from '../collectors/telegram/telegram.service';
import { VkService } from '../collectors/social/vk.service';
import { OpenAiWebSearchService } from '../collectors/social-search/openai-web-search.service';
import { Source, SourceKind } from '../sources/source.entity';
import { MentionSourceType } from '../mentions/mention.entity';
import { CollectedItem } from '../common/collector-run.util';
import { Keyword } from '../keywords/keyword.entity';
import { Sentiment } from '../mentions/mention.entity';
import { fetchRssWithDeepScan } from '../collectors/rss/rss-deep-scan.util';
import { fetchParserWithDeepScan } from '../collectors/parser/parser-deep-scan.util';

// The backend runs on Vercel's Hobby plan, which hard-caps every function invocation at 60s
// (vercel.json's maxDuration is ignored — see telegram-bot.service.ts) — /search is one such
// invocation, running every channel/source sequentially, `await`ed, inside it. This is the hard
// ceiling for the whole runSearch() call, leaving a margin below 60s for Nest/DB overhead and for
// sending the Telegram reply itself. See README "Бюджет времени /search".
const SEARCH_TIME_BUDGET_MS = parseInt(process.env.SEARCH_TIME_BUDGET_MS || '45000', 10);

// Per-source cap on the ParserService.deepCollect() sitemap/HTML-pagination pass — shared by BOTH
// the RSS channel (RSS's deep pass on top of its feed) and the Parser channel (a PARSER source's
// only path), since both ultimately call the exact same deepCollect(). Several sources of either
// kind can become "due" for their deep pass in the same /search call, and one slow/huge site must
// not be able to eat the whole SEARCH_TIME_BUDGET_MS on its own, starving every source queued up
// after it — this was a real incident: with RSS's deep pass left unbounded, a single due RSS
// source silently consumed the entire /search budget by itself before anything else got a turn,
// making every other source (RSS, Parser, Telegram, NewsAPI, VK, OpenAI web search alike) show up
// as "не удалось опросить" even though nothing was actually broken.
const PARSER_SOURCE_TIME_BUDGET_MS = parseInt(process.env.PARSER_ONDEMAND_SOURCE_BUDGET_MS || '10000', 10);

// Reduced article cap for the routine /search deep pass (RSS's and Parser's alike) —
// PARSER_MAX_ARTICLES_PER_CRAWL/PARSER_MAX_SITEMAP_ARTICLE_URLS (60 by default, see
// parser.service.ts) are sized for a one-time backfill of a *single* source (onboarding's
// «Добавить по ссылке»), not for however many sources happen to be due this /search call while
// sharing one time budget between them.
const PARSER_ONDEMAND_MAX_ARTICLES = parseInt(process.env.PARSER_ONDEMAND_MAX_ARTICLES || '15', 10);

// Tighter (but still non-zero, to avoid hammering a site from a server IP) crawl delay for the
// server-triggered /search pass (RSS's and Parser's deep pass alike) — PARSER_CRAWL_DELAY_MS's
// polite 400ms default is fine for a one-off onboarding crawl but adds up across several due
// sources sharing SEARCH_TIME_BUDGET_MS.
const PARSER_ONDEMAND_CRAWL_DELAY_MS = parseInt(process.env.PARSER_ONDEMAND_CRAWL_DELAY_MS || '150', 10);

const TIMEOUT_SKIP_MESSAGE =
  'пропущено: не хватило времени в рамках лимита Vercel (60с) — попробуйте более короткий период или повторите запрос';

export interface OnDemandSearchResultItem {
  title: string;
  url: string;
  sourceLabel: string;
  publishedAt: Date | null;
  /** 'new' = this run actually inserted it; 'known' = it (or a near-duplicate) already existed. */
  status: 'new' | 'known';
  /**
   * Real classified tone, not always "не определена": /search uses
   * MentionsService.createIfNewAndClassify (awaits classification) instead of the fire-and-forget
   * createIfNew used by background collection — see that method's comment for why this is safe
   * only here.
   */
  sentiment: Sentiment;
}

export interface OnDemandSearchSummary {
  periodDays: number;
  totalMatched: number;
  newCount: number;
  knownCount: number;
  items: OnDemandSearchResultItem[];
  sourcesFailed: Array<{ label: string; error: string }>;
  /** Number of times the OpenAI web search tool was invoked for this single /search run. */
  openAiWebSearchCalls: number;
}

interface ChannelSpec {
  channelName: string;
  kind: SourceKind;
  sourceType: MentionSourceType;
  fetchItems: (source: Source, keywords: Keyword[]) => Promise<CollectedItem[]>;
  /** See CreateMentionInput.skipDedup — only the consolidated OpenAI web search channel sets this. */
  skipDedup?: boolean;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Разовый ("по требованию") поиск за произвольный период — команда /search в Telegram-боте.
 * Сознательно НЕ переиспользует runCollectionCycle() напрямую: та функция в самом начале
 * проверяет settingsService.isCollectionEnabled() и молча пропускает цикл при /pause — а
 * разовый поиск по требованию должен работать независимо от того, приостановлен ли фоновый
 * автосбор (см. README/CLAUDE.md по этой задаче). Логика дедупликации и сохранения переиспользуется
 * через тот же MentionsService.createIfNew(...), так что найденные новые упоминания всё равно
 * попадают в общий поток /pause-независимых Telegram-алертов через отдельную очередь.
 *
 * Период фильтруется best-effort — только когда у находки вообще есть publishedAt. У
 * консолидированного OpenAI web search (К-6) даты нет никогда (сам инструмент их не отдаёт),
 * поэтому такие находки показываются независимо от выбранного периода; для RSS/Parser это
 * тоже best-effort — сайт отдаёт только тот срез данных, который у него есть сейчас, глубже
 * "заглянуть" мы не можем.
 */
@Injectable()
export class OnDemandSearchService {
  private readonly logger = new Logger(OnDemandSearchService.name);

  constructor(
    private readonly sourcesService: SourcesService,
    private readonly mentionsService: MentionsService,
    private readonly keywordsService: KeywordsService,
    private readonly rssService: RssService,
    private readonly parserService: ParserService,
    private readonly newsApiService: NewsApiService,
    private readonly telegramService: TelegramService,
    private readonly vkService: VkService,
    private readonly openAiWebSearchService: OpenAiWebSearchService,
  ) {}

  async runSearch(periodDays: number): Promise<OnDemandSearchSummary> {
    const startedAt = Date.now();
    // Hard deadline for this whole call — checked before every source, across every channel, not
    // just Parser's. See SEARCH_TIME_BUDGET_MS above and README "Бюджет времени /search".
    const deadline = startedAt + SEARCH_TIME_BUDGET_MS;

    const activeKeywords = (await this.keywordsService.findAll()).filter((k) => k.isActive);
    const keywordSet = await this.keywordsService.loadActiveKeywordSet();
    const cutoff = new Date(Date.now() - periodDays * 24 * 60 * 60 * 1000);

    const channels: ChannelSpec[] = [
      {
        channelName: 'RSS',
        kind: SourceKind.RSS,
        sourceType: MentionSourceType.NEWS,
        // RSS on its own only ever surfaces a feed's last N items (see CLAUDE.md task on RSS
        // backfill depth) — layer the throttled sitemap/HTML-pagination deep pass on top so
        // material that already scrolled out of the feed still gets picked up periodically.
        //
        // budget is NOT optional here even though fetchRssWithDeepScan allows omitting it — see
        // the incident note on that function. Reuses the exact same PARSER_ONDEMAND_* knobs as the
        // Parser channel below (not separate RSS-specific ones): both ultimately call the same
        // ParserService.deepCollect(), and RSS being first in `channels` means it's the one most
        // likely to eat the whole budget if left unbounded — confirmed live (see README "Бюджет
        // времени /search").
        fetchItems: (source) =>
          fetchRssWithDeepScan({
            source,
            logger: this.logger,
            rssService: this.rssService,
            parserService: this.parserService,
            sourcesService: this.sourcesService,
            budget: {
              deadline: Math.min(deadline, Date.now() + PARSER_SOURCE_TIME_BUDGET_MS),
              maxArticles: PARSER_ONDEMAND_MAX_ARTICLES,
              crawlDelayMs: PARSER_ONDEMAND_CRAWL_DELAY_MS,
            },
          }),
      },
      {
        channelName: 'Parser',
        kind: SourceKind.PARSER,
        sourceType: MentionSourceType.OTHER,
        // A PARSER source has no RSS feed at all (that's *why* it's PARSER, not RSS — see
        // source-detect.service.ts), so fetchPage() alone only ever parsed the source's own URL as
        // if it were a single article — no real article on the site was ever read. This layers the
        // same sitemap/HTML-pagination deep pass RSS gets on top of its feed (see CLAUDE.md task
        // "PARSER-источники не проходят обход"). Reduced maxArticles/crawlDelayMs and a per-source
        // deadline (capped by whatever's left of the overall /search budget) because this can run
        // for several due sources inside one shared SEARCH_TIME_BUDGET_MS — see the constants above.
        fetchItems: (source) =>
          fetchParserWithDeepScan({
            source,
            logger: this.logger,
            parserService: this.parserService,
            sourcesService: this.sourcesService,
            budget: {
              deadline: Math.min(deadline, Date.now() + PARSER_SOURCE_TIME_BUDGET_MS),
              maxArticles: PARSER_ONDEMAND_MAX_ARTICLES,
              crawlDelayMs: PARSER_ONDEMAND_CRAWL_DELAY_MS,
            },
          }).then((result) => result.items),
      },
      {
        channelName: 'Telegram',
        kind: SourceKind.TELEGRAM,
        sourceType: MentionSourceType.TELEGRAM,
        fetchItems: (source) => this.telegramService.fetchChannel(source.url),
      },
      {
        channelName: 'Search API (NewsAPI)',
        kind: SourceKind.SEARCH_API,
        sourceType: MentionSourceType.NEWS,
        fetchItems: (_source, keywords) => this.newsApiService.search(keywords),
      },
      {
        channelName: 'Social API (VK)',
        kind: SourceKind.SOCIAL_API,
        sourceType: MentionSourceType.SOCIAL,
        fetchItems: (_source, keywords) => this.vkService.search(keywords),
      },
      {
        channelName: 'Social search (OpenAI web search)',
        kind: SourceKind.SOCIAL_SEARCH_API,
        sourceType: MentionSourceType.SOCIAL_SEARCH,
        fetchItems: (_source, keywords) => this.openAiWebSearchService.search(keywords),
        // Every web search result is its own independent finding, not a reprint of the same
        // story — see CreateMentionInput.skipDedup.
        skipDedup: true,
      },
    ];

    const items: OnDemandSearchResultItem[] = [];
    const sourcesFailed: Array<{ label: string; error: string }> = [];
    let newCount = 0;
    let knownCount = 0;
    let openAiWebSearchCalls = 0;
    let sourcesSkippedByTimeout = 0;

    for (const channel of channels) {
      const sources = await this.sourcesService.findActiveByType(channel.kind);

      for (const source of sources) {
        // Checked before every single source, across every channel (not just Parser's deep scan)
        // — see SEARCH_TIME_BUDGET_MS above. The user must always get a reply (see
        // TelegramBotService.runOnDemandSearchAndReport), so an exhausted budget marks whatever's
        // left as skipped instead of continuing to run and risking Vercel killing the invocation
        // mid-request with no response at all — see README "Бюджет времени /search".
        if (Date.now() >= deadline) {
          sourcesSkippedByTimeout += 1;
          const label = source.name || source.url;
          sourcesFailed.push({ label, error: TIMEOUT_SKIP_MESSAGE });
          continue;
        }

        try {
          const fetched = await channel.fetchItems(source, activeKeywords);
          if (channel.kind === SourceKind.SOCIAL_SEARCH_API) {
            openAiWebSearchCalls += 1;
          }
          // /search is now the only thing that ever polls a source (background collection was
          // removed for the Vercel deploy — see README "Деплой на Vercel"), so this is the only
          // place left that can keep "Источники"'s last-success/status columns truthful.
          await this.sourcesService.markSuccess(source.id);

          for (const item of fetched) {
            if (item.publishedAt && item.publishedAt < cutoff) {
              continue;
            }

            const { matched } = await keywordSet.match(item.title, item.text);
            if (!matched) {
              continue;
            }

            const sourceLabel = item.sourceLabel || source.name || this.domainOf(item.url);

            const { result, sentiment } = await this.mentionsService.createIfNewAndClassify({
              title: item.title,
              text: item.text,
              url: item.url,
              publishedAt: item.publishedAt,
              sourceId: source.id,
              sourceType: channel.sourceType,
              sourceLabel: item.sourceLabel ?? null,
              hash: item.hash,
              keywords: [],
              isBackfill: false,
              skipDedup: channel.skipDedup,
            });

            if (result === 'inserted') {
              newCount += 1;
            } else {
              knownCount += 1;
            }

            items.push({
              title: item.title,
              url: item.url,
              sourceLabel,
              publishedAt: item.publishedAt,
              status: result === 'inserted' ? 'new' : 'known',
              sentiment,
            });
          }
        } catch (error) {
          const label = source.name || source.url;
          const message = describeError(error);
          sourcesFailed.push({ label, error: message });
          await this.sourcesService.markError(source.id, message);
          this.logger.error(`/search: источник "${label}" (${channel.channelName}) завершился ошибкой: ${message}`);
        }
      }
    }

    const elapsedMs = Date.now() - startedAt;
    if (sourcesSkippedByTimeout > 0) {
      this.logger.warn(
        `/search: бюджет времени (${SEARCH_TIME_BUDGET_MS}мс) исчерпан — пропущено по тайм-ауту ${sourcesSkippedByTimeout} источник(ов)`,
      );
    }

    // Cost auditing: this must stay 1 (a single consolidated web search call) regardless of
    // periodDays — the whole point of Part 1's consolidation is that the period picker does NOT
    // multiply OpenAI spend. elapsedMs is logged permanently (not just for one-off measurement) so
    // a load-test run against several slow PARSER sources at once can be verified straight from
    // this line — see README "Бюджет времени /search".
    this.logger.log(
      `/search завершён за ${elapsedMs}мс: период=${periodDays} дн., найдено=${items.length} (новых=${newCount}, ` +
        `уже известных=${knownCount}), источников с ошибкой=${sourcesFailed.length} ` +
        `(из них по тайм-ауту=${sourcesSkippedByTimeout}), ` +
        `вызовов OpenAI web search за этот запрос=${openAiWebSearchCalls} (сверяйте с панелью OpenAI usage)`,
    );

    return {
      periodDays,
      totalMatched: items.length,
      newCount,
      knownCount,
      items,
      sourcesFailed,
      openAiWebSearchCalls,
    };
  }

  private domainOf(url: string): string {
    try {
      return new URL(url).hostname;
    } catch {
      return url;
    }
  }
}