import { resolveDbConfig } from './database.util';

export default () => ({
  port: parseInt(process.env.PORT || '3000', 10),
  db: resolveDbConfig(),
  rss: {
    pollIntervalMinutes: parseInt(process.env.RSS_POLL_INTERVAL_MINUTES || '10', 10),
  },
  newsApi: {
    // К-1 поисковый/новостной канал: NewsAPI.org — бесплатный ключ без ручной модерации,
    // простой REST-эндпоинт /v2/everything с булевым синтаксисом запроса (совпадает с
    // нашими "обязательное ИЛИ обязательное" ключевыми словами).
    apiKey: process.env.NEWSAPI_KEY || '',
    pollIntervalMinutes: parseInt(process.env.NEWSAPI_POLL_INTERVAL_MINUTES || '15', 10),
  },
  telegram: {
    // К-3: читаем публичную веб-версию канала (t.me/s/<channel>) — она отдаёт последние
    // посты без токена бота и без вступления в канал, что снимает требование "бот должен
    // быть админом канала" у обычного Bot API.
    pollIntervalMinutes: parseInt(process.env.TELEGRAM_POLL_INTERVAL_MINUTES || '10', 10),
  },
  vk: {
    // К-4 соцсеть: ВКонтакте — official API, свободная регистрация приложения и выдача
    // access_token без ручной модерации (в отличие от X/Meta), подходит для рынка РФ/КЗ.
    accessToken: process.env.VK_ACCESS_TOKEN || '',
    apiVersion: process.env.VK_API_VERSION || '5.199',
    pollIntervalMinutes: parseInt(process.env.VK_POLL_INTERVAL_MINUTES || '15', 10),
  },
  parser: {
    pollIntervalMinutes: parseInt(process.env.PARSER_POLL_INTERVAL_MINUTES || '20', 10),
  },
  openaiSocialSearch: {
    // К-6: Instagram/Facebook/Threads/публичные Telegram-каналы через инструмент веб-поиска
    // OpenAI (Responses API, tools: [{ type: 'web_search' }]) — это поиск по уже
    // проиндексированному открытому вебу, не прямой доступ к приватным данным соцсетей.
    apiKey: process.env.OPENAI_API_KEY || '',
    // Домен-фильтр (filters.allowed_domains) на практике поддерживается только моделями
    // семейства GPT-5+ с веб-поиском (проверено вживую: gpt-4o-mini отвечает 400 Invalid
    // Parameter 'filters' not supported with model 'gpt-4o-mini') — gpt-4o-mini как дефолт
    // не подходит, несмотря на то что дешевле.
    model: process.env.OPENAI_SOCIAL_SEARCH_MODEL || 'gpt-5-mini',
    // Платный инструмент (~$10/1000 вызовов + токены) — держим интервал в пределах 30–60 мин,
    // не чаще; фактическое значение ниже 30 принудительно поднимается до 30 (см. scheduler).
    pollIntervalMinutes: parseInt(process.env.OPENAI_SOCIAL_SEARCH_POLL_INTERVAL_MINUTES || '45', 10),
    // Временное отключение К-6 как канала СБОРА — по умолчанию false на этот период; тот же
    // OPENAI_API_KEY продолжает использоваться отдельно для тональности (см. sentimentAnalysis
    // ниже) независимо от этого флага. Установите SOCIAL_SEARCH_ENABLED=true, чтобы включить К-6 обратно.
    enabled: process.env.SOCIAL_SEARCH_ENABLED === 'true',
  },
  sentimentAnalysis: {
    // Определение тональности упоминаний (Позитив/Негатив/Нейтрал) через обычный (без
    // web_search) запрос к OpenAI Responses API — переиспользует тот же ключ, что и К-6, но
    // отдельную (более дешёвую) модель, т.к. это простая классификация текста, а не поиск.
    apiKey: process.env.OPENAI_API_KEY || '',
    model: process.env.OPENAI_SENTIMENT_MODEL || 'gpt-5-mini',
  },
  telegramBot: {
    // Notification bot (distinct from the К-3 collector above, which scrapes public channels
    // with no token). Created once via @BotFather — see docs/telegram-setup.md.
    token: process.env.TELEGRAM_BOT_TOKEN || '',
    chatId: process.env.TELEGRAM_CHAT_ID || '',
    // Checked against the `X-Telegram-Bot-Api-Secret-Token` header on every POST /telegram/webhook
    // call (TelegramWebhookController) before the update is even parsed — Telegram sends this
    // header back verbatim on every webhook call once it's set via `npm run set-webhook`
    // (bot.telegram.setWebhook(url, { secret_token })). Without it, the webhook path (a public,
    // guessable-from-source URL) would accept forged updates from anyone.
    webhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET || '',
  },
  backfill: {
    // How far back a source's one-time historical catch-up run reaches, best-effort — only
    // enforced when an item's publishedAt is actually known; RSS/parser can't reach further back
    // than what the source itself still exposes regardless of this number. Read directly from
    // process.env in collector-run.util.ts (a plain function, not part of Nest DI) — kept here
    // too so the schema/default is documented in one place alongside every other setting.
    days: parseInt(process.env.BACKFILL_DAYS || '60', 10),
  },
  excludedDomains: {
    // Comma-separated domain blacklist (each entry also covers its subdomains) — a domain here
    // must never appear in `sources` (admin "add by link") or `mentions` (K-1/K-6 whole-web
    // search findings). Read directly from process.env in DomainExclusionService (see that file
    // for why); kept here too so the schema/default is documented alongside every other setting.
    // See README "Исключение доменов (blacklist)".
    raw: process.env.EXCLUDED_DOMAINS || '',
  },
});