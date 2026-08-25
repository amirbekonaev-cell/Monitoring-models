import { Logger } from '@nestjs/common';
import { Source } from '../sources/source.entity';
import { SourcesService } from '../sources/sources.service';
import { MentionsService } from '../mentions/mentions.service';
import { Mention } from '../mentions/mention.entity';
import { ActiveKeywordSet, KeywordsService } from '../keywords/keywords.service';

export interface CollectedItem {
  title: string;
  text: string;
  url: string;
  publishedAt: Date | null;
  hash: string;
}

export interface CollectorCycleSummary {
  sourcesOk: number;
  sourcesFailed: number;
  itemsFound: number;
  itemsNew: number;
  itemsReprint: number;
  itemsFilteredByKeywords: number;
}

/**
 * Runs one collection cycle over a list of sources for a single channel. Each source is
 * isolated in its own try/catch (ФТ-2: one broken source must never take down the others
 * or the rest of the cycle) and its status is updated in the sources registry either way.
 */
export async function runCollectionCycle(params: {
  logger: Logger;
  channelName: string;
  sources: Source[];
  sourcesService: SourcesService;
  mentionsService: MentionsService;
  keywordsService: KeywordsService;
  sourceType: Mention['sourceType'];
  fetchItems: (source: Source) => Promise<CollectedItem[]>;
}): Promise<CollectorCycleSummary> {
  const { logger, channelName, sources, sourcesService, mentionsService, keywordsService, sourceType, fetchItems } =
    params;

  logger.log(`${channelName} cycle start: ${sources.length} active source(s) to poll`);

  const summary: CollectorCycleSummary = {
    sourcesOk: 0,
    sourcesFailed: 0,
    itemsFound: 0,
    itemsNew: 0,
    itemsReprint: 0,
    itemsFilteredByKeywords: 0,
  };

  // Snapshot once per cycle: keyword edits mid-cycle apply to the *next* cycle, not this one.
  const keywordSet = await keywordsService.loadActiveKeywordSet();

  for (const source of sources) {
    try {
      const items = await fetchItems(source);
      summary.itemsFound += items.length;

      for (const item of items) {
        const { matched } = await matchKeywords(keywordSet, item);
        if (!matched) {
          summary.itemsFilteredByKeywords += 1;
          continue;
        }

        const result = await mentionsService.createIfNew({
          title: item.title,
          text: item.text,
          url: item.url,
          publishedAt: item.publishedAt,
          sourceId: source.id,
          sourceType,
          hash: item.hash,
          keywords: [],
        });

        if (result === 'inserted') {
          summary.itemsNew += 1;
        } else if (result === 'reprint') {
          summary.itemsReprint += 1;
        }
      }

      await sourcesService.markSuccess(source.id);
      summary.sourcesOk += 1;
    } catch (error) {
      summary.sourcesFailed += 1;
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`${channelName} source failed: ${source.url} — ${message}`);
      await sourcesService.markError(source.id, message);
    }
  }

  logger.log(
    `${channelName} cycle done: sources ok=${summary.sourcesOk} failed=${summary.sourcesFailed}, ` +
      `items found=${summary.itemsFound} new=${summary.itemsNew} reprints=${summary.itemsReprint} ` +
      `filtered=${summary.itemsFilteredByKeywords}`,
  );

  return summary;
}

async function matchKeywords(keywordSet: ActiveKeywordSet, item: CollectedItem) {
  return keywordSet.match(item.title, item.text);
}
