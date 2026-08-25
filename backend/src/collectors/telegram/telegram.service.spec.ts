import { TelegramService, extractTelegramChannel } from './telegram.service';

describe('extractTelegramChannel', () => {
  it.each([
    ['https://t.me/somechannel', 'somechannel'],
    ['t.me/somechannel', 'somechannel'],
    ['https://t.me/s/somechannel', 'somechannel'],
    ['@somechannel', 'somechannel'],
    ['somechannel', 'somechannel'],
  ])('extracts channel from %s', (input, expected) => {
    expect(extractTelegramChannel(input)).toBe(expected);
  });

  it('returns null for a non-Telegram URL', () => {
    expect(extractTelegramChannel('https://example.com/news')).toBeNull();
  });
});

describe('TelegramService', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('throws a clear error (not a stack trace) when the channel preview is empty/unreachable', async () => {
    global.fetch = jest.fn(async () => ({
      ok: true,
      text: async () => '<html><body>no such channel</body></html>',
    })) as unknown as typeof fetch;

    const service = new TelegramService();
    await expect(service.fetchChannel('https://t.me/doesnotexist')).rejects.toThrow(/не найден|приватный/);
  });

  it('parses posts out of the public channel preview page', async () => {
    const html = `
      <div class="tgme_channel_info"></div>
      <div class="tgme_widget_message_wrap">
        <a class="tgme_widget_message_date" href="https://t.me/somechannel/123">
          <time class="time" datetime="2026-08-19T10:00:00+00:00"></time>
        </a>
        <div class="tgme_widget_message_text">Первая строка поста\nвторая строка</div>
      </div>
    `;
    global.fetch = jest.fn(async () => ({ ok: true, text: async () => html })) as unknown as typeof fetch;

    const service = new TelegramService();
    const items = await service.fetchChannel('https://t.me/somechannel');

    expect(items).toHaveLength(1);
    expect(items[0].url).toBe('https://t.me/somechannel/123');
    expect(items[0].title).toContain('Первая строка поста');
  });
});
