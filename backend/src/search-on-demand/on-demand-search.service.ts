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
    const activeKeywords = (await this.keywordsService.findAll()).filter((k) => k.isActive);
    const keywordSet = await this.keywordsService.loadActiveKeywordSet();
    const cutoff = new Date(Date.now() - periodDays * 24 * 60 * 60 * 1000);

    const channels: ChannelSpec[] = [
      {
        channelName: 'RSS',
        kind: SourceKind.RSS,
        sourceType: MentionSourceType.NEWS,
        fetchItems: (source) => this.rssService.fetchFeed(source.url),
      },
      {
        channelName: 'Parser',
        kind: SourceKind.PARSER,
        sourceType: MentionSourceType.OTHER,
        fetchItems: (source) => this.parserService.fetchPage(source.url),
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

    for (const channel of channels) {
      const sources = await this.sourcesService.findActiveByType(channel.kind);

      for (const source of sources) {
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

    // Cost auditing: this must stay 1 (a single consolidated web search call) regardless of
    // periodDays — the whole point of Part 1's consolidation is that the period picker does NOT
    // multiply OpenAI spend.
    this.logger.log(
      `/search завершён: период=${periodDays} дн., найдено=${items.length} (новых=${newCount}, ` +
        `уже известных=${knownCount}), источников с ошибкой=${sourcesFailed.length}, ` +
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