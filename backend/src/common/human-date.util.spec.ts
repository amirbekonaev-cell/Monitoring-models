import { findUnambiguousDate, parseHumanReadableDate } from './human-date.util';

describe('parseHumanReadableDate', () => {
  // The exact shapes observed live on the pool's sites — these are what the extractor has to
  // handle, and the reason 81 of ~169 links would otherwise carry no date at all.
  it.each([
    ['20 января 2023', Date.UTC(2023, 0, 20)],
    ['7 октября 2021', Date.UTC(2021, 9, 7)],
    ['1 мая 2024', Date.UTC(2024, 4, 1)],
    ['31 декабря 2020', Date.UTC(2020, 11, 31)],
    ['15 августа 2019', Date.UTC(2019, 7, 15)],
  ])('reads the Russian form %s', (input, expected) => {
    expect(parseHumanReadableDate(input)).toEqual(new Date(expected));
  });

  it.each([
    ['22 қыркүйек 2026', Date.UTC(2026, 8, 22)],
    ['3 наурыз 2024', Date.UTC(2024, 2, 3)],
    ['10 желтоқсан 2022', Date.UTC(2022, 11, 10)],
  ])('reads the Kazakh form %s', (input, expected) => {
    expect(parseHumanReadableDate(input)).toEqual(new Date(expected));
  });

  it('reads a declined Kazakh month form', () => {
    expect(parseHumanReadableDate('22 қыркүйегі 2026')).toEqual(new Date(Date.UTC(2026, 8, 22)));
  });

  it.each([
    ['28.10.2024', Date.UTC(2024, 9, 28)],
    ['17-12-2024', Date.UTC(2024, 11, 17)],
    ['05/03/2021', Date.UTC(2021, 2, 5)],
  ])('reads the day-first numeric form %s', (input, expected) => {
    expect(parseHumanReadableDate(input)).toEqual(new Date(expected));
  });

  it('reads the ISO-like numeric form', () => {
    expect(parseHumanReadableDate('2024-12-17')).toEqual(new Date(Date.UTC(2024, 11, 17)));
  });

  it('finds the date inside surrounding prose', () => {
    expect(parseHumanReadableDate('Опубликовано: 20 января 2023, 14:35 · Новости')).toEqual(
      new Date(Date.UTC(2023, 0, 20)),
    );
  });

  it('prefers a written-out month over a numeric run elsewhere in the text', () => {
    // A named month is unambiguous; a bare numeric run in body text ("1 637 шарт") is not.
    expect(parseHumanReadableDate('1 637 шарт · 20 января 2023')).toEqual(new Date(Date.UTC(2023, 0, 20)));
  });

  it('rejects an impossible calendar date rather than rolling it over', () => {
    expect(parseHumanReadableDate('31 февраля 2023')).toBeNull();
    expect(parseHumanReadableDate('31.02.2023')).toBeNull();
  });

  it('returns null when there is no date at all', () => {
    expect(parseHumanReadableDate('Просто текст статьи без даты')).toBeNull();
    expect(parseHumanReadableDate('')).toBeNull();
    expect(parseHumanReadableDate('   ')).toBeNull();
  });

  it('does not mistake a bare year or a long number for a date', () => {
    expect(parseHumanReadableDate('Итоги 2024 года')).toBeNull();
    expect(parseHumanReadableDate('заключено 1 637 договоров')).toBeNull();
    expect(parseHumanReadableDate('номер 65434810')).toBeNull();
  });

  it('is case-insensitive and tolerates collapsed whitespace', () => {
    expect(parseHumanReadableDate('20  ЯНВАРЯ\n2023')).toEqual(new Date(Date.UTC(2023, 0, 20)));
  });
});

describe('findUnambiguousDate', () => {
  it('returns the date when the text names exactly one', () => {
    // sk.kz: the article date sits outside the headline's subtree, but it is the page's only date.
    expect(findUnambiguousDate('... қамтамасыз етеді 1258 22 Сәуір 2020 «Қазақтелеком» ...')).toEqual(
      new Date(Date.UTC(2020, 3, 22)),
    );
  });

  it('returns the date when the same day is repeated in different places', () => {
    expect(findUnambiguousDate('20 января 2023 ... опубликовано 20 января 2023')).toEqual(
      new Date(Date.UTC(2023, 0, 20)),
    );
  });

  it('returns null as soon as two different dates appear — the sidebar case', () => {
    // A "latest news" sidebar is exactly this shape, and picking one of its dates would stamp an
    // old article with today's, putting it inside every /search period forever.
    expect(findUnambiguousDate('20 января 2023 ... 22 сентября 2026 ... 21 сентября 2026')).toBeNull();
  });

  it('returns null for text with no date', () => {
    expect(findUnambiguousDate('Статья без единой даты')).toBeNull();
    expect(findUnambiguousDate('')).toBeNull();
  });

  it('terminates on a long text full of dates instead of scanning forever', () => {
    const many = Array.from({ length: 300 }, (_, i) => `${(i % 28) + 1} января 202${i % 4}`).join(' ');
    expect(findUnambiguousDate(many)).toBeNull();
  });
});
