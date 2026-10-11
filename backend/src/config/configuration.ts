import { resolveDbConfig } from './database.util';
import { parseCuratedMinArticleDate } from '../curated/curated-min-article-date.util';
import { parseSearchPeriodDays } from '../curated/search-period.util';
import { parseSearchMinDurationMs } from '../curated/search-progress.util';
import { resolveTelegramBotMode } from '../notifications/telegram/telegram-bot-mode.util';

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
    // 'polling' (default off Vercel) | 'webhook' (default on Vercel, which sets VERCEL itself).
    // The local docker compose stand MUST use polling: Telegram cannot POST to localhost, so a
    // webhook-only bot silently answers nothing there. See telegram-bot-mode.util.ts.
    mode: resolveTelegramBotMode(process.env.TELEGRAM_BOT_MODE, Boolean(process.env.VERCEL)),
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
  curated: {
    // /search and /status now read only this closed pool of pre-vetted links (see
    // CuratedSearchService) — no network/collector calls happen during either command any more.
    // Calendar-day window boundaries (dateFrom/dateTo) are computed in this timezone, not UTC —
    // see curated-date.util.ts.
    timezone: process.env.SEARCH_TIMEZONE || 'Asia/Almaty',
    // /search period picker buttons — see search-period.util.ts for validation/defaults/labels.
    periodDays: parseSearchPeriodDays(process.env.SEARCH_PERIOD_DAYS),
    // Greedy per-message packing limit for the /search results list (Telegram messages are
    // capped ~4096 chars) — a page holds as many items as fit under this, then a "Показать ещё"
    // button loads the rest.
    messageCharLimit: parseInt(process.env.SEARCH_MESSAGE_CHAR_LIMIT || '3500', 10),
    // --- Наполнение пула (ПРОМПТ 2, CuratedIngestService) ---
    // 'auto' — сначала бесплатный HTTP-парсер, и только если страница не отдалась (анти-бот,
    // JS-рендер, пустой текст) — платное чтение через OpenAI. 'openai' — всегда через OpenAI
    // (дороже, нужен только для отладки или для домена, который парсер не берёт в принципе).
    readMode: process.env.CURATED_READ_MODE === 'openai' ? 'openai' : 'auto',
    // Ниже этого объёма текст страницы считается не статьёй, а заглушкой/тизером — включается
    // fallback на OpenAI. Совпадает по смыслу с MIN_FULL_TEXT_LENGTH в SentimentAnalysisService.
    minPageTextChars: parseInt(process.env.CURATED_MIN_PAGE_TEXT_CHARS || '400', 10),
    // Сколько раз пробовать ссылку, прежде чем пометить её failed.
    maxAttempts: parseInt(process.env.CURATED_MAX_ATTEMPTS || '3', 10),
    // Потолок времени на ОДНУ ссылку целиком (скачивание + OpenAI + тональность), AbortController.
    linkTimeoutMs: parseInt(process.env.CURATED_LINK_TIMEOUT_MS || '25000', 10),
    // Сколько ссылок обрабатывается одновременно (разных хостов — к одному хосту всегда один
    // запрос за раз, см. HostQueue).
    concurrency: parseInt(process.env.CURATED_CONCURRENCY || '4', 10),
    // Пауза между запросами к ОДНОМУ хосту — вежливость к сайту (у sknews.kz 49 ссылок подряд).
    hostDelayMs: parseInt(process.env.CURATED_HOST_DELAY_MS || '300', 10),
    // --- Ленивая дообработка внутри /search (см. CuratedSearchService.search) ---
    lazyProcess: process.env.CURATED_LAZY_PROCESS === 'true',
    lazyMaxLinks: parseInt(process.env.CURATED_LAZY_MAX_LINKS || '10', 10),
    lazyBudgetMs: parseInt(process.env.CURATED_LAZY_BUDGET_MS || '20000', 10),
    // Отдавать ли ссылки скрытых упоминаний в REST API/фронт. По умолчанию false. На Telegram-бота
    // НЕ влияет: он ссылки не показывает никогда (ПРОМПТ 1). См. mention-privacy.util.ts.
    exposeUrls: process.env.CURATED_LINKS_EXPOSE_URLS === 'true',
    // --- Аддитивные настройки пула (по умолчанию выключены = прежнее поведение) ---
    // Отсечка по дате статьи: статья раньше этой даты не превращается в упоминание (ссылка
    // получает статус not_relevant). Пусто/не задано/некорректно — отсечки нет, см.
    // curated-min-article-date.util.ts (невалидное значение только пишет warn, не падает).
    minArticleDate: parseCuratedMinArticleDate(process.env.CURATED_MIN_ARTICLE_DATE),
    // Длина пересказа (в словах), которую запрашивает промпт тональности ТОЛЬКО для ссылок пула.
    // Пусто/0 — промпт остаётся ровно прежним (1-2 предложения, ~250 символов) для всех каналов,
    // включая пул. См. SentimentAnalysisService.classify(options).
    summaryWords: parseInt(process.env.CURATED_SUMMARY_WORDS || '0', 10),
    // До скольких символов CuratedSearchService обрезает summary при показе. Для summaryWords=50
    // осмысленное значение ~420; по умолчанию 250 — столько же, сколько было зашито в коде.
    summaryDisplayChars: parseInt(process.env.CURATED_SUMMARY_DISPLAY_CHARS || '250', 10),
    // true — каждая находка /search уходит отдельным сообщением (порциями, см. ниже), а не
    // упакованной в одну "страницу" по messageCharLimit. По умолчанию false = прежний вывод.
    oneArticlePerMessage: process.env.SEARCH_ONE_ARTICLE_PER_MESSAGE === 'true',
    // Минимальное время от нажатия кнопки периода до первой страницы выдачи. Набор карточек
    // фильтруется за миллисекунды, и мгновенный ответ читается как «всё было готово заранее», а
    // не как ответ на заданный период; 30 с — темп, в котором видно счётчик проверенных
    // материалов. 0 — отдавать сразу (прежнее поведение). Потолок — см. search-progress.util.ts:
    // весь /search это один 60-секундный вызов на Vercel, и отправка сообщений тоже в него входит.
    minDurationMs: parseSearchMinDurationMs(process.env.SEARCH_MIN_DURATION_MS),
    // Сколько отдельных сообщений отправлять за одно нажатие кнопки. Ограничение сверху — лимит
    // Telegram (~20 сообщений/мин в группу) и 60-секундный потолок Vercel: порция × пауза между
    // сообщениями должна укладываться в бюджет вызова с большим запасом.
    itemsPerBatch: parseInt(process.env.SEARCH_ITEMS_PER_BATCH || '8', 10),
  },
  liveSearch: {
    // Живой проход по RSS-лентам изданий внутри /search (см. LiveRssSearchService). Единственный
    // канал сбора, который успевает отработать в запросе: замерено на реальной сети — 17 лент
    // параллельно за 3.2 с, 1760 материалов, у всех есть дата. Идёт ВНУТРИ паузы
    // SEARCH_MIN_DURATION_MS, поэтому к длительности /search ничего не добавляет.
    // Выключается только явным SEARCH_LIVE_RSS=false.
    enabled: process.env.SEARCH_LIVE_RSS !== 'false',
    // Потолок на весь проход и на одну ленту. Оба — внешним Promise.race: `timeout` у rss-parser
    // на замере не сработал, лента висела минутами с выставленными ему 15 с.
    budgetMs: parseInt(process.env.SEARCH_LIVE_RSS_BUDGET_MS || '12000', 10),
    feedTimeoutMs: parseInt(process.env.SEARCH_LIVE_RSS_FEED_TIMEOUT_MS || '8000', 10),
    // Формы названия компании для живого прохода. Пусто — формы по умолчанию (те же, что сеет
    // npm run seed:keywords). Дублируются в коде, а не читаются из таблицы `keywords`, потому что
    // /search обязан работать без базы — см. brand-match.util.ts.
    brandForms: process.env.LIVE_SEARCH_BRAND_FORMS || '',
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