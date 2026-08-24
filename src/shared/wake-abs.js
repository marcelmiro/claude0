/**
 * Absolute wake moment — shared by the Mac sidebar (snooze-form preview,
 * commit flash, detail line via `sidebar/ansi.ts`) and the mobile bridge UI
 * (snooze toast; served as `/wake-abs.js`), so one wake never renders two
 * ways. Fixed English format, TUI-style, by decision: the project is
 * English-only, and a hard-coded pattern is deterministic across machines
 * and ICU versions (Intl was tried — Bun ignores LANG for its default
 * locale, and ICU builds disagree on locale data like en-GB's hour cycle).
 *
 * - same local calendar day  → time only          ("9AM", "10:32PM")
 * - < 7 calendar days ahead  → weekday + time     ("Tue 9AM")
 * - ≥ 7 calendar days ahead  → dd/MM + time       ("26/09 9AM")
 * Minutes are omitted when the time falls on the hour.
 */

const DAY = 86_400_000;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Calendar-day distance in LOCAL days (0 = same day), independent of clock time. */
function localDayDiff(now, until) {
  const a = new Date(now);
  a.setHours(0, 0, 0, 0);
  const b = new Date(until);
  b.setHours(0, 0, 0, 0);
  // round, not divide: a DST shift makes the midnight gap ±1h off a multiple of 24h
  return Math.round((b.getTime() - a.getTime()) / DAY);
}

export function formatWakeAbs(until, now) {
  const dt = new Date(until);
  const mins = dt.getMinutes();
  const time = `${((dt.getHours() + 11) % 12) + 1}${
    mins ? `:${String(mins).padStart(2, "0")}` : ""
  }${dt.getHours() < 12 ? "AM" : "PM"}`;
  const days = localDayDiff(now, until);
  if (days === 0) return time;
  if (days < 7) return `${WEEKDAYS[dt.getDay()]} ${time}`;
  const dd = String(dt.getDate()).padStart(2, "0");
  const mm = String(dt.getMonth() + 1).padStart(2, "0");
  return `${dd}/${mm} ${time}`;
}
