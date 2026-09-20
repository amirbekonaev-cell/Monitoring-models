/**
 * Calendar-date helpers for the closed-pool /search period window. Deliberately NOT millisecond
 * arithmetic (`now.getTime() - days * 86400000`) — a period must line up with calendar days in
 * SEARCH_TIMEZONE (Asia/Almaty by default), and ms subtraction drifts across DST-observing zones
 * and doesn't mean "N calendar days ago" near a month/year boundary anyway. Every function here
 * works on the target zone's Y-M-D components, computed once via Intl.DateTimeFormat (built into
 * Node, no date library needed), then does the arithmetic in plain UTC-midnight `Date`s — safe
 * because at that point DST/offset no longer matters, only the calendar.
 */

/** `now` rendered as the target zone's calendar date, "YYYY-MM-DD". */
export function zonedDateString(now: Date, timeZone: string): string {
  // en-CA formats as YYYY-MM-DD directly — no manual reassembly of formatToParts needed.
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

/** `dateStr` (YYYY-MM-DD) minus `days` calendar days, still "YYYY-MM-DD". Handles month/year
 *  rollovers and leap years for free — it's plain `Date.UTC` arithmetic on Y-M-D components. */
export function subtractCalendarDays(dateStr: string, days: number): string {
  const [year, month, day] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(year, month - 1, day));
  dt.setUTCDate(dt.getUTCDate() - days);
  return dt.toISOString().slice(0, 10);
}

/** "YYYY-MM-DD" -> "dd.mm.yyyy" for display. */
export function formatIsoDateDisplay(dateStr: string): string {
  const [year, month, day] = dateStr.split('-');
  return `${day}.${month}.${year}`;
}

/** A timestamptz rendered as "dd.mm.yyyy" in the target zone — for per-item dates in bot messages. */
export function formatDateInTimezone(date: Date, timeZone: string): string {
  return formatIsoDateDisplay(zonedDateString(date, timeZone));
}
