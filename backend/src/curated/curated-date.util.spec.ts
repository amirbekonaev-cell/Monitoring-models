import { formatDateInTimezone, formatIsoDateDisplay, subtractCalendarDays, zonedDateString } from './curated-date.util';

const TZ = 'Asia/Almaty'; // UTC+5, no DST — verified via Intl at write time.

describe('zonedDateString', () => {
  it('renders the calendar date in the target zone, not UTC — regression test for the midnight boundary', () => {
    // 2026-06-15T20:30:00Z is still "15th" in UTC but already "16th" 01:30 in Asia/Almaty (+5h).
    const now = new Date('2026-06-15T20:30:00Z');
    expect(zonedDateString(now, TZ)).toBe('2026-06-16');
  });

  it('stays on the same calendar day when the UTC and zoned dates agree', () => {
    const now = new Date('2026-06-15T06:00:00Z'); // 11:00 in Almaty — same day either way
    expect(zonedDateString(now, TZ)).toBe('2026-06-15');
  });
});

describe('subtractCalendarDays', () => {
  it('N=1: yesterday', () => {
    expect(subtractCalendarDays('2026-09-16', 1)).toBe('2026-09-15');
  });

  it('N=730 (2 years)', () => {
    expect(subtractCalendarDays('2026-09-16', 730)).toBe('2024-09-16');
  });

  it('crosses a month boundary', () => {
    expect(subtractCalendarDays('2026-03-01', 1)).toBe('2026-02-28');
  });

  it('crosses a year boundary', () => {
    expect(subtractCalendarDays('2026-01-01', 1)).toBe('2025-12-31');
  });

  it('handles a leap year correctly (2024-02-29 exists)', () => {
    expect(subtractCalendarDays('2024-03-01', 1)).toBe('2024-02-29');
  });

  it('handles subtracting across a leap day from a non-leap year', () => {
    expect(subtractCalendarDays('2025-03-01', 366)).toBe('2024-02-29');
  });
});

describe('formatIsoDateDisplay', () => {
  it('renders YYYY-MM-DD as dd.mm.yyyy', () => {
    expect(formatIsoDateDisplay('2026-09-16')).toBe('16.09.2026');
  });
});

describe('formatDateInTimezone', () => {
  it('formats a timestamptz as dd.mm.yyyy in the target zone', () => {
    const date = new Date('2026-06-15T20:30:00Z'); // 16th in Almaty
    expect(formatDateInTimezone(date, TZ)).toBe('16.06.2026');
  });
});
