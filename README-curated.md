# Готовые карточки упоминаний QazCloud (168 штук)

Все заголовки, даты, пересказы и тональности уже написаны вручную. Бот ничего не генерирует
и не вызывает LLM — он берёт готовый текст из JSON и отправляет его как отдельное сообщение
на каждое упоминание.

## Что куда положить

Скопируйте файлы в репозиторий, сохранив пути:

Всё уже лежит в репозитории:

```
backend/src/curated/curated-mentions.data.json          ← данные (единственный источник правды)
backend/src/curated/curated-mentions.ts                 ← типы + поиск + форматирование сообщения
backend/src/curated/curated-mentions.service.ts         ← Nest-сервис (DI)
backend/src/curated/curated-mentions.module.ts          ← Nest-модуль
backend/src/curated/curated-mentions.spec.ts            ← тесты целостности данных
backend/src/curated/curated-mentions-message.util.ts    ← тексты команд /curated_stats, /curated
backend/src/scripts/seed-curated-mentions.ts            ← перенос карточек в таблицу mentions
backend/src/scripts/send-curated-mentions.ts            ← рассылка карточек в Telegram
```

**Почему файл данных называется `curated-mentions.data.json`, а не `curated-mentions.json`.**
Рядом лежит `curated-mentions.ts`. При совпадении базовых имён `tsc` разрешает импорт
`../curated/curated-mentions` в `.ts` и собирается без единой ошибки, а Node и ts-node — в
`.json`. Код компилировался, но в рантайме оба скрипта получали голый массив вместо модуля и
падали на первом же вызове (`getCuratedSortedByDate is not a function`). Разные базовые имена
убирают неоднозначность.

`resolveJsonModule` в `backend/tsconfig.json` уже включён. В `backend/nest-cli.json` добавлены
`assets` (`curated/*.json` → `dist`), в `backend/package.json` — скрипты `seed:curated` и
`send:curated`. Отдельно настраивать ничего не нужно.

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

> **Сначала проверьте, в какую базу вы целитесь.** `backend/.env` задаёт `DATABASE_URL`, а он в
> `resolveDbConfig()` сильнее, чем `DB_HOST`. Поэтому `npm run seed:curated` из `backend/` идёт
> **не в локальный docker-compose, а в удалённую базу деплоя (Neon)**. Скрипт печатает целевую
> базу первой строкой — прочитайте её до того, как запускать без `--dry-run`.

```bash
cd backend
npm run seed:curated -- --dry-run   # показать план, ничего не записывая
npm run seed:curated                # применить

# то же самое, но по локальному стенду docker compose:
DATABASE_URL= DB_HOST=127.0.0.1 DB_PORT=5432 DB_USER=postgres DB_PASSWORD=postgres DB_NAME=mentions \
  npx ts-node -r tsconfig-paths/register src/scripts/seed-curated-mentions.ts --dry-run
```

**Что делает скрипт.** Эти 167 статей уже есть в базе: их туда положил закрытый пул ссылок
(`CuratedIngestService`) со скрытым URL (`url_hidden = true`) и с заголовком/пересказом от
модели. Карточки описывают те же материалы, только текст и тональность в них написаны руками.
Поэтому скрипт **не вставляет вторую строку на ту же статью**, а обновляет существующую:
подменяет машинный текст ручным, ставит `sentimentManual = true` и `notificationSent = true`.
Строки, которых в базе нет, добавляются; ссылка из пула и при вставке остаётся скрытой.

Сопоставление идёт по нормализованному URL, а не по точному совпадению строки: в пуле ссылки
лежат без завершающего слеша, а в карточках он есть у 79 из 167. Поиск по точному `url` нашёл
бы только 88 статей, а для остальных 79 создал бы дубликаты — причём видимые, то есть ссылки
закрытого пула утекли бы в неаутентифицированный `GET /mentions`.

Три замка, которые ставит скрипт:

- `sentimentManual = true` — фоновый классификатор не перетрёт ручную оценку. Это гарантия на
  уровне SQL: и `MentionsService.updateSentiment`, и `classify-sentiment-backfill.ts` пишут
  только `WHERE sentiment_manual = false`, а backfill ещё и выбирает строки тем же условием —
  карточки в его выборку просто не попадают.
- `notificationSent = true` — алерты по этим упоминаниям не уходят.
- `isBackfill = true` (у новых строк) — пометка «историческая догрузка».

Повторный запуск идемпотентен: на вход подаются те же значения, второй прогон сообщает «без
изменений» и ничего не пишет.

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

`--dry-run` ничего не отправляет и не ходит в сеть — его можно запускать свободно. Без флага
скрипт шлёт настоящие сообщения в `TELEGRAM_CHAT_ID`; отменить отправку в Telegram нельзя,
поэтому сначала посмотрите вывод с `--dry-run`.

## Команды бота

| Команда | Что делает |
|---|---|
| `/curated_stats` | Сколько карточек всего, разбивка по тональности и по изданиям |
| `/curated <домен>` | Карточки одного издания, например `/curated sknews.kz` |

Карточки уходят пачками по 8 с паузой 700 мс и кнопкой «Показать ещё»: у sknews.kz их 49, а
Telegram пропускает в группу около 20 сообщений в минуту — отправка разом получила бы 429 на всю
пачку. Обе команды работают только в рабочей группе (`TELEGRAM_CHAT_ID`), как `/status` и
`/search`.

## Встроено в существующий бот

- `TelegramNotifierService.formatMessage` — если для `mention.url` есть карточка, уходит её
  готовый текст; для всех остальных ссылок прежняя логика не изменилась (закреплено тестом).
- `SentimentAnalysisService.classify` — для ссылки из набора возвращает тональность и пересказ
  из карточки, не обращаясь к OpenAI. Проверка стоит до чтения `OPENAI_API_KEY`: для этих
  материалов тональность определяется даже без ключа.

## Проверка

```bash
cd backend
npx tsc --noEmit                      # типы
npx jest src/curated                  # карточки + закрытый пул
npx jest                              # весь набор: 41 сьют, 525 тестов
npm run build && ls dist/curated/      # JSON должен попасть в dist
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

Правьте только `curated-mentions.data.json` — код трогать не нужно. После правки прогоните
`npx jest src/curated` и, если карточки уже в базе, `npm run seed:curated` (он увидит разницу и
обновит только изменившиеся строки).

Если меняете число карточек, поправьте и ожидаемое значение в `curated-mentions.spec.ts`
(`toHaveLength(168)`) — тест специально держит это число фиксированным, чтобы случайная потеря
записи при редактировании JSON не прошла незамеченной.
