import { Logger } from '@nestjs/common';

const logger = new Logger('BrandMatch');

/**
 * Написания названия компании, по которым живой проход по RSS-лентам узнаёт упоминание.
 *
 * Те же формы, что сеет `npm run seed:keywords` (см. seed-keywords.ts) — там они лежат в таблице
 * `keywords`, здесь продублированы в коде намеренно: /search обязан работать без базы (карточки
 * читаются из JSON, см. CuratedJsonSearchService), и живой проход не вправе добавлять ему
 * зависимость от БД, которой на стенде может не быть поднято вовсе.
 *
 * Сравнение литеральное и без учёта регистра, поэтому «КазКлауд»/«QAZCLOUD»/«qazcloud» покрыты
 * базовыми формами и отдельных записей не требуют. Отдельная форма нужна там, где меняется САМ
 * СИМВОЛ: казахская «Қ» в «Қазклауд» — это не русская «К», и текст с ней не совпал бы ни с чем.
 * Часть материалов набора — на казахском.
 */
export const DEFAULT_BRAND_FORMS: readonly string[] = [
  'QazCloud',
  'Qaz Cloud',
  'Казклауд',
  'Каз Клауд',
  'Қазклауд',
  'Қаз Клауд',
];

/**
 * Разбирает `LIVE_SEARCH_BRAND_FORMS` ("QazCloud,Казклауд,…"). Пусто/не задано — формы по
 * умолчанию; мусор (строка из одних запятых) — предупреждение в лог и формы по умолчанию:
 * проход без единой формы совпал бы с КАЖДОЙ новостью всех лент, а это хуже, чем не искать вовсе.
 */
export function parseBrandForms(raw: string | undefined): string[] {
  if (raw === undefined || !raw.trim()) {
    return [...DEFAULT_BRAND_FORMS];
  }

  const forms = raw
    .split(',')
    .map((form) => form.trim())
    .filter((form) => form.length > 0);

  if (forms.length === 0) {
    logger.warn(
      `LIVE_SEARCH_BRAND_FORMS="${raw}" не содержит ни одной формы — использую формы по умолчанию: ` +
        DEFAULT_BRAND_FORMS.join(','),
    );
    return [...DEFAULT_BRAND_FORMS];
  }

  return [...new Set(forms)];
}

/**
 * Совпал ли материал с названием компании. Заголовок и текст проверяются вместе: в ленте
 * заголовок часто безымянный («Подписано соглашение»), а название стоит в описании.
 *
 * Минус-слова (`Астан`/`Astana`/`медицин`/`medic`, см. seed-minus-keywords.ts) здесь НЕ
 * применяются, и это не упущение. Они появились как противовес тому, что когда-то «Астана» была
 * ОБЯЗАТЕЛЬНЫМ словом и тащила за собой весь городской новостной поток. Когда обязательное слово
 * одно — название компании, — вето по ним отбрасывает настоящие находки: под него попали бы 14 из
 * 167 карточек набора, вручную проверенных человеком. Материал, в котором буквально написано
 * «QazCloud», — это упоминание, сколько бы раз в нём ни встретилась Астана.
 */
export function matchesBrand(forms: readonly string[], title: string, text: string): boolean {
  const haystack = `${title}\n${text}`.toLowerCase();
  return forms.some((form) => {
    const needle = form.trim().toLowerCase();
    return needle.length > 0 && haystack.includes(needle);
  });
}
