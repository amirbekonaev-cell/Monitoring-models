# Готовые карточки упоминаний QazCloud (168 штук)

Все заголовки, даты, пересказы и тональности уже написаны вручную. Бот ничего не генерирует
и не вызывает LLM — он берёт готовый текст из JSON и отправляет его как отдельное сообщение
на каждое упоминание.

## Что куда положить

Скопируйте файлы в репозиторий, сохранив пути:

```
backend/src/curated/curated-mentions.json        ← данные (единственный источник правды)
backend/src/curated/curated-mentions.ts          ← типы + поиск + форматирование сообщения
backend/src/curated/curated-mentions.service.ts  ← Nest-сервис (DI)
backend/src/curated/curated-mentions.module.ts   ← Nest-модуль
backend/src/curated/curated-mentions.spec.ts     ← тесты целостности данных
backend/src/scripts/seed-curated-mentions.ts     ← загрузка карточек в таблицу mentions
backend/src/scripts/send-curated-mentions.ts     ← рассылка карточек в Telegram
```

`resolveJsonModule` в `backend/tsconfig.json` уже включён, поэтому импорт JSON заработает без
правок конфига. Чтобы JSON попал в `dist` при сборке, добавьте в `backend/nest-cli.json`:

```json
{
  "compilerOptions": {
    "assets": [{ "include": "curated/*.json", "outDir": "dist" }],
    "watchAssets": true
  }
}
```

Добавьте два скрипта в `backend/package.json`:

```json
"seed:curated": "ts-node -r tsconfig-paths/register src/scripts/seed-curated-mentions.ts",
"send:curated": "ts-node -r tsconfig-paths/register src/scripts/send-curated-mentions.ts"
```

## Формат одной записи

```jsonc
{
  "id": "17.13",                       // номер пункта из вашего документа — стабильный ключ
  "sourceName": "SK News",
  "sourceDomain": "sknews.kz",
  "title": "QazCloud и VK Cloud запускают локализованную облачную платформу в Казахстане",
  "url": "https://sknews.kz/news/view/...",
  "publishedAt": "2023-04-25",         // ISO-день или null, если дату установить не удалось
  "publishedAtText": "25.04.2023",     // дата в том виде, как она стоит на сайте
  "summary": "VK Cloud запускается в Казахстане с партнёром QazCloud...",
  "sentiment": "positive",             // positive | neutral | negative | undefined
  "sentimentNote": "компания выступает ключевым инфраструктурным партнёром",
  "status": "verified",                // verified | partial | unverified | duplicate
  "duplicateOf": "3.10"                // только у дубликатов
}
```

## Как бот достаёт данные

```ts
import { CuratedMentionsService } from '../curated/curated-mentions.service';

// 1. Есть ли готовая карточка для этой ссылки
const mention = this.curated.byUrl(url);
if (mention) {
  await bot.telegram.sendMessage(chatId, this.curated.formatMessage(mention), {
    parse_mode: 'HTML',
  });
  return; // ничего не генерируем — текст уже готов
}

// 2. Прочие выборки
this.curated.all();                    // все 168
this.curated.sortedByDate();           // новые сверху
this.curated.byId('17.13');
this.curated.bySource('profit.kz');
this.curated.bySentiment('negative');
this.curated.stats();                  // { total, positive, neutral, negative, bySource }
```

Без Nest те же функции доступны напрямую:

```ts
import { CURATED_MENTIONS, findCuratedByUrl, formatCuratedMessage } from './curated/curated-mentions';
```

Поиск по URL нормализован: схема, `www.`, завершающий слеш и `?utm_*`-хвосты совпадению
не мешают.

## Встраивание в существующий пайплайн

В `TelegramNotifierService.formatMessage` достаточно одной проверки в начале — тогда для
проверенных ссылок уйдёт ручной текст, для всех остальных останется текущая логика:

```ts
const curated = findCuratedByUrl(mention.url);
if (curated) return formatCuratedMessage(curated);
```

То же самое имеет смысл сделать в `SentimentAnalysisService`: если ссылка есть в наборе,
классификатор можно не вызывать — тональность уже проставлена человеком.

## Загрузка в базу

```bash
cd backend
npm run seed:curated             # добавить недостающие, существующие пропустить
npm run seed:curated -- --force  # перезаписать текст и тональность у уже залитых
```

Что делает скрипт: находит или создаёт запись в `sources` по домену, затем пишет в `mentions`
с `sentimentManual: true` (фоновый классификатор не перетрёт ручную оценку),
`notificationSent: true` (бот не вывалит 168 алертов в чат разом) и `isBackfill: true`.
Повторный запуск безопасен — идемпотентность по `url`.

## Рассылка в Telegram

```bash
npm run send:curated -- --dry-run            # посмотреть текст, ничего не отправляя
npm run send:curated                         # все 168, по одному сообщению
npm run send:curated -- --source=sknews.kz   # только одно издание
npm run send:curated -- --id=17.13           # одна карточка
npm run send:curated -- --limit=10 --delay=1500
```

Нужны `TELEGRAM_BOT_TOKEN` и `TELEGRAM_CHAT_ID` в `.env`. Самое длинное сообщение — 927
символов при лимите Telegram в 4096, так что ничего не обрежется.

## Проверка

```bash
cd backend
npx jest src/curated/curated-mentions.spec.ts
```

Тесты проверяют: 168 записей, уникальность id, заполненность обязательных полей, корректность
ISO-дат, работу поиска по URL и то, что ни одно сообщение не выходит за лимит Telegram.

## Что внутри набора

| Параметр | Значение |
|---|---|
| Всего карточек | 168 |
| Позитивных | 122 |
| Нейтральных | 44 |
| Негативных | 2 (5.1 Inbusiness, плюс ещё одна — см. `bySentiment('negative')`) |
| С установленной датой | 167 из 168 (у 13.14 даты нет на сайте) |
| Изданий | 20 |

Крупнейшие источники: SK News — 49, Profit.kz — 19, Bluescreen — 18, DKNews — 15, Kursiv — 14,
The Tech — 13.

## Расхождения с исходным документом

- **Пункты 14.15, 14.19 и 19.18 отсутствуют** — в присланном документе их нет. 14.15 был
  дубликатом 14.14, а 14.19 (bluescreen, рекомендации по поиску угроз) и 19.18 (profit.kz,
  интервью «облачные деньги должны оставаться в стране») просто не попали в файл. Если они
  нужны, допишите их в JSON — формат тот же.
- **Пункт 3.3** в документе шёл без строки «Ссылка», URL подставлен из исходного списка
  (`dknews.kz/kz/alem-zhanalyktary/285153-...`).
- **Пункт 3.14** помечен как дубликат 3.10, данные скопированы из оригинала; URL у них общий.
- **Пункт 19.9** имел смешанную оценку «нейтрально-позитивная» — записан как `neutral`,
  исходная формулировка сохранена в `sentimentNote`. Если нужен `positive`, поправьте одну
  строку в JSON.
- **Пункт 1.5** содержал две строки тональности подряд; взята первая («Позитивная»).

## Как править данные

Правьте только `curated-mentions.json` — код трогать не нужно. После правки прогоните тесты
и, если карточки уже в базе, `npm run seed:curated -- --force`.
