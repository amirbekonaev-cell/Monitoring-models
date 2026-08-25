import { ConfigService } from '@nestjs/config';
import { TelegramNotifierService } from './telegram-notifier.service';
import { TelegramBotService } from './telegram-bot.service';
import { Mention } from '../../mentions/mention.entity';
import { Source } from '../../sources/source.entity';

const sendMessageMock = jest.fn();

function makeTelegramBotService(): TelegramBotService {
  return {
    getBot: jest.fn(() => ({ telegram: { sendMessage: sendMessageMock } })),
  } as unknown as TelegramBotService;
}

function makeMention(overrides: Partial<Mention> = {}): Mention {
  return {
    id: 'm-1',
    title: 'Компания QazCloud объявила о новом продукте',
    text: 'A'.repeat(400),
    url: 'https://example.kz/news/1',
    publishedAt: new Date('2026-08-19T10:00:00Z'),
    foundAt: new Date(),
    sourceId: 'src-1',
    sourceType: 'news',
    language: null,
    sentiment: 'undefined',
    sentimentManual: false,
    hash: 'h1',
    keywords: [],
    reprints: [],
    notificationSent: false,
    isBackfill: false,
    createdAt: new Date(),
    ...overrides,
  } as unknown as Mention;
}

function makeConfig(values: Record<string, string>): ConfigService {
  return { get: jest.fn((key: string) => values[key]) } as unknown as ConfigService;
}

describe('TelegramNotifierService', () => {
  beforeEach(() => {
    sendMessageMock.mockReset();
    sendMessageMock.mockResolvedValue(undefined);
  });

  it('formats a message with title, source, sentiment, snippet, date and link', () => {
    const config = makeConfig({ 'telegramBot.token': 'tok', 'telegramBot.chatId': '-100' });
    const service = new TelegramNotifierService(config, makeTelegramBotService());
    const source = { name: 'Example.kz' } as Source;

    const message = service.formatMessage(makeMention(), source);

    expect(message).toContain('QazCloud');
    expect(message).toContain('Example.kz');
    expect(message).toContain('https://example.kz/news/1');
    expect(message).toContain('…'); // snippet truncated past 300 chars
    expect(message).toContain('⬜ Не определена'); // sentiment: 'undefined' fixture default
  });

  it('shows the classified sentiment label and summary when set', () => {
    const config = makeConfig({ 'telegramBot.token': 'tok', 'telegramBot.chatId': '-100' });
    const service = new TelegramNotifierService(config, makeTelegramBotService());

    const message = service.formatMessage(
      makeMention({ sentiment: 'positive' as Mention['sentiment'], summary: 'QazCloud получил отраслевую награду.' }),
      null,
    );

    expect(message).toContain('🟩 Позитив');
    expect(message).toContain('📝 <i>QazCloud получил отраслевую награду.</i>');
  });

  it('falls back to the URL domain when the source has no name', () => {
    const config = makeConfig({ 'telegramBot.token': 'tok', 'telegramBot.chatId': '-100' });
    const service = new TelegramNotifierService(config, makeTelegramBotService());

    const message = service.formatMessage(makeMention(), null);

    expect(message).toContain('example.kz');
  });

  it('throws a clear error instead of sending when TELEGRAM_CHAT_ID is missing', async () => {
    const config = makeConfig({ 'telegramBot.token': 'tok', 'telegramBot.chatId': '' });
    const service = new TelegramNotifierService(config, makeTelegramBotService());

    await expect(service.sendMentionAlert(makeMention(), null)).rejects.toThrow('TELEGRAM_CHAT_ID');
  });

  it('re-throws a Telegram API failure with the chat_id spelled out explicitly (e.g. bot lost admin rights)', async () => {
    sendMessageMock.mockRejectedValueOnce(new Error('Forbidden: bot was kicked from the group chat'));
    const config = makeConfig({ 'telegramBot.token': 'tok', 'telegramBot.chatId': '-100500' });
    const service = new TelegramNotifierService(config, makeTelegramBotService());

    await expect(service.sendMentionAlert(makeMention(), null)).rejects.toThrow(
      'Бот не может отправить сообщение в chat_id -100500: Forbidden: bot was kicked from the group chat',
    );
  });

  it('sends through the shared TelegramBotService bot instance (not its own)', async () => {
    const config = makeConfig({ 'telegramBot.token': 'tok', 'telegramBot.chatId': '-100' });
    const botService = makeTelegramBotService();
    const service = new TelegramNotifierService(config, botService);

    await service.sendMentionAlert(makeMention(), null);

    expect(botService.getBot).toHaveBeenCalled();
    expect(sendMessageMock).toHaveBeenCalledWith('-100', expect.any(String), expect.objectContaining({ parse_mode: 'HTML' }));
  });
});