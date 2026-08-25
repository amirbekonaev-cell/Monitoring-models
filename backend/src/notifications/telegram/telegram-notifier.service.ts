import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Mention, Sentiment } from '../../mentions/mention.entity';
import { Source } from '../../sources/source.entity';
import { TelegramBotService } from './telegram-bot.service';

const SNIPPET_LENGTH = 350;

const SENTIMENT_LABEL: Record<Sentiment, string> = {
  [Sentiment.POSITIVE]: '🟩 Позитив',
  [Sentiment.NEGATIVE]: '🟥 Негатив',
  [Sentiment.NEUTRAL]: '🟨 Нейтрал',
  [Sentiment.UNDEFINED]: '⬜ Не определена',
};

/**
 * Negative → positive scale, not just a single-color label: three cells (негатив/нейтрал/
 * позитив), with the one matching the mention's actual sentiment lit up and the other two shown
 * dim, so the position on the scale reads at a glance instead of requiring the text label.
 * Sentiment.UNDEFINED shows all three dim — there's no position to point at yet.
 */
const SENTIMENT_SCALE: Record<Sentiment, string> = {
  [Sentiment.NEGATIVE]: '🔴⚪⚪',
  [Sentiment.NEUTRAL]: '⚪🟡⚪',
  [Sentiment.POSITIVE]: '⚪⚪🟢',
  [Sentiment.UNDEFINED]: '⚪⚪⚪',
};

@Injectable()
export class TelegramNotifierService {
  private readonly logger = new Logger(TelegramNotifierService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly telegramBotService: TelegramBotService,
  ) {}

  async sendMentionAlert(mention: Mention, source: Source | null): Promise<void> {
    const chatId = this.config.get<string>('telegramBot.chatId');
    if (!chatId) {
      throw new Error('TELEGRAM_CHAT_ID не задан в .env — запустите scripts/get-chat-id.ts и впишите значение');
    }

    const text = this.formatMessage(mention, source);
    try {
      await this.telegramBotService.getBot().telegram.sendMessage(chatId, text, {
        parse_mode: 'HTML',
      });
    } catch (error) {
      // Re-thrown with the chat_id spelled out explicitly (ФТ requirement: an admin reading
      // the logs after the bot got demoted/removed must see plainly *which* chat failed and
      // why — not just Telegraf's bare API error, and never swallowed silently).
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`Бот не может отправить сообщение в chat_id ${chatId}: ${reason}`);
    }
  }

  formatMessage(mention: Mention, source: Source | null): string {
    // mention.sourceLabel wins when present — it's the explicit per-result domain returned by
    // channels that can surface more than one platform per call (K-6, consolidated web search);
    // source?.name covers everything else (one Source row per site/feed/channel).
    const sourceLabel = mention.sourceLabel || source?.name || this.domainOf(mention.url);
    const domain = this.domainOf(mention.url);
    const href = escapeAttr(mention.url);

    const compactDateTime = this.formatCompactDateTime(mention.publishedAt);
    const fullDate = mention.publishedAt
      ? mention.publishedAt.toLocaleString('ru-RU', { timeZone: 'Asia/Almaty' })
      : 'дата не определена';

    const trimmedText = mention.text?.trim() ?? '';
    const snippet = truncate(trimmedText, SNIPPET_LENGTH);
    const firstParagraph = truncate(trimmedText.split(/\n\s*\n/)[0]?.trim() || trimmedText, SNIPPET_LENGTH);

    // Тональность определяется асинхронно (см. SentimentClassifyProcessor) и может ещё не
    // быть готова к моменту отправки этого уведомления — тогда покажет "Не определена";
    // итоговое значение всегда видно в карточке упоминания в UI. Шкала (SENTIMENT_SCALE) даёт
    // визуальную позицию негатив→нейтрал→позитив, а не только текстовую подпись.
    const headerLine =
      `${SENTIMENT_SCALE[mention.sentiment]} ${SENTIMENT_LABEL[mention.sentiment]} | ` +
      `<a href="${href}">${escapeHtml(domain)}</a> | ${compactDateTime}`;
    const titleLine = `<b><a href="${href}">${escapeHtml(mention.title)}</a></b>`;
    const dateLine = `🗓 ${fullDate}`;

    // Короткий пересказ от той же модели, что определяет тональность (SentimentAnalysisService,
    // поле summary) — готов не сразу (классификация асинхронная), тогда просто не показывается,
    // сырой обрезанный фрагмент текста ниже остаётся как есть.
    const trimmedSummary = mention.summary?.trim();
    const summaryLine = trimmedSummary ? `📝 <i>${escapeHtml(trimmedSummary)}</i>` : null;

    const quoteLines = [
      `<b>${escapeHtml(sourceLabel)}</b>`,
      escapeHtml(mention.title),
      firstParagraph ? escapeHtml(firstParagraph) : null,
    ].filter((line): line is string => Boolean(line));

    const lines = [
      headerLine,
      titleLine,
      dateLine,
      summaryLine,
      snippet ? escapeHtml(snippet) : null,
      `<blockquote>${quoteLines.join('\n')}</blockquote>`,
    ].filter((line): line is string => Boolean(line));

    return lines.join('\n\n');
  }

  private domainOf(url: string): string {
    try {
      return new URL(url).hostname;
    } catch {
      return url;
    }
  }

  private formatCompactDateTime(date: Date | null): string {
    if (!date) {
      return 'дата не определена';
    }
    const parts = new Intl.DateTimeFormat('ru-RU', {
      timeZone: 'Asia/Almaty',
      hour: '2-digit',
      minute: '2-digit',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour12: false,
    })
      .formatToParts(date)
      .reduce<Record<string, string>>((acc, part) => {
        acc[part.type] = part.value;
        return acc;
      }, {});
    return `${parts.hour}:${parts.minute} ${parts.day}.${parts.month}.${parts.year}`;
  }
}

function truncate(text: string, maxLen: number): string {
  const trimmed = text.trim();
  return trimmed.length > maxLen ? `${trimmed.slice(0, maxLen)}…` : trimmed;
}

function escapeHtml(input: string): string {
  return input.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(input: string): string {
  return escapeHtml(input).replace(/"/g, '&quot;');
}
