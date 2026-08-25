export default () => ({
  port: parseInt(process.env.PORT || '3000', 10),
  db: {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    username: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
    database: process.env.DB_NAME || 'mentions',
  },
  redis: {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
  },
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
});
