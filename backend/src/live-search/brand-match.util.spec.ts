import { Logger } from '@nestjs/common';
import { DEFAULT_BRAND_FORMS, matchesBrand, parseBrandForms } from './brand-match.util';

const FORMS = [...DEFAULT_BRAND_FORMS];

describe('parseBrandForms', () => {
  it('не задано или пусто — формы по умолчанию', () => {
    expect(parseBrandForms(undefined)).toEqual(FORMS);
    expect(parseBrandForms('')).toEqual(FORMS);
    expect(parseBrandForms('   ')).toEqual(FORMS);
  });

  it('читает список через запятую, обрезая пробелы и повторы', () => {
    expect(parseBrandForms('QazCloud, Казклауд ,QazCloud')).toEqual(['QazCloud', 'Казклауд']);
  });

  /**
   * Проход без единой формы совпал бы с КАЖДОЙ новостью всех лент и залил бы чат мусором — это
   * хуже, чем не искать вовсе, поэтому мусор на входе откатывается к формам по умолчанию.
   */
  it('строка без форм — предупреждение и формы по умолчанию', () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    expect(parseBrandForms(',,,')).toEqual(FORMS);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('matchesBrand', () => {
  it('узнаёт название в заголовке и в тексте, в любом регистре', () => {
    expect(matchesBrand(FORMS, 'QazCloud открыл дата-центр', '')).toBe(true);
    expect(matchesBrand(FORMS, 'КАЗКЛАУД подписал меморандум', '')).toBe(true);
    expect(matchesBrand(FORMS, 'qazcloud в цифрах', '')).toBe(true);
    // В ленте заголовок часто безымянный, а название стоит в описании.
    expect(matchesBrand(FORMS, 'Подписано соглашение', 'Компания QazCloud и партнёр договорились')).toBe(true);
  });

  /** Казахская «Қ» — другой символ, а не «К»: без отдельной формы такой текст не совпал бы. */
  it('узнаёт казахское написание через Қ', () => {
    expect(matchesBrand(FORMS, 'Қазклауд деректер орталығы', '')).toBe(true);
    expect(matchesBrand(FORMS, 'Қаз Клауд туралы', '')).toBe(true);
  });

  it('узнаёт написание в два слова', () => {
    expect(matchesBrand(FORMS, 'Qaz Cloud launches', '')).toBe(true);
    expect(matchesBrand(FORMS, 'Каз Клауд открыл офис', '')).toBe(true);
  });

  it('не срабатывает на посторонних новостях', () => {
    expect(matchesBrand(FORMS, 'В Астане открыли новую поликлинику', 'Медицина стала доступнее')).toBe(false);
    expect(matchesBrand(FORMS, 'Google Cloud и Amazon', 'облачные провайдеры')).toBe(false);
    expect(matchesBrand(FORMS, '', '')).toBe(false);
  });

  /**
   * Минус-слова (Астан/медицин, см. seed-minus-keywords.ts) к живому проходу не применяются: когда
   * обязательное слово одно — название компании, — вето по ним отбрасывает НАСТОЯЩИЕ находки. Под
   * него попали бы 14 из 167 вручную проверенных карточек набора.
   */
  it('находит упоминание, даже если в тексте есть минус-слова прежних правил', () => {
    expect(matchesBrand(FORMS, 'QazCloud построит дата-центр в Астане', 'Проект в Астане')).toBe(true);
    expect(matchesBrand(FORMS, 'Казклауд и медицина', 'медицинские данные в облаке')).toBe(true);
  });

  it('пустые формы не совпадают ни с чем — пустая строка не подстрока-джокер', () => {
    expect(matchesBrand(['', '   '], 'любая новость', 'любой текст')).toBe(false);
  });
});
