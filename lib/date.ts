/**
 * Calendar helpers for the `YYYYMM` integer month used throughout the
 * services layer. Everything here is UTC: transaction dates are stored as
 * UTC midnights, so a local-time boundary would silently pull a neighbouring
 * month's first or last day into the range.
 */

/**
 * Half-open range covering one calendar month: `start` is that month's first
 * UTC midnight, `end` is the *next* month's, so queries pair it with
 * `{ gte: start, lt: end }`.
 */
export const monthRange = (month: number): { start: Date; end: Date } => {
  const year = Math.floor(month / 100);
  const monthIndex = (month % 100) - 1;
  const start = new Date(Date.UTC(year, monthIndex, 1));
  const end = new Date(Date.UTC(year, monthIndex + 1, 1));
  return { start, end };
};

/** Number of days in the given `YYYYMM` month (28/29/30/31). */
export const daysInMonth = (month: number): number => {
  const year = Math.floor(month / 100);
  const monthIndex = (month % 100) - 1;
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
};

/** Signed number of months from `from` to `to` (`YYYYMM` both). */
export const monthsBetween = (from: number, to: number): number =>
  Math.floor(to / 100) * 12 + (to % 100) - (Math.floor(from / 100) * 12 + (from % 100));

/** The `YYYYMM` month `delta` months after (or, negative, before) `month`. */
export const shiftMonth = (month: number, delta: number): number => {
  const year = Math.floor(month / 100);
  const date = new Date(Date.UTC(year, (month % 100) - 1 + delta, 1));
  return date.getUTCFullYear() * 100 + (date.getUTCMonth() + 1);
};

/** `YYYYMM` of the UTC month `date` falls in. */
export const monthOfDate = (date: Date): number =>
  date.getUTCFullYear() * 100 + (date.getUTCMonth() + 1);

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

const pad2 = (n: number): string => String(n).padStart(2, '0');

/**
 * The `YYYY-MM-DD` calendar date a stored transaction date falls on. Stored
 * dates are UTC midnights, so this reads the UTC day. Use this instead of
 * `toISOString().slice(0, 10)` so every caller shares one definition.
 */
export const toDateKey = (date: Date): string => date.toISOString().slice(0, 10);

/**
 * UTC midnight for a `YYYY-MM-DD` calendar date, or null when the string is
 * not one or names a day that does not exist (`2026-02-30` would otherwise
 * roll over to March 2).
 */
export const fromDateKey = (key: string): Date | null => {
  if (!DATE_KEY.test(key)) return null;
  const date = new Date(`${key}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) || toDateKey(date) !== key ? null : date;
};

/**
 * Today's `YYYY-MM-DD` in the *viewer's* timezone. Only for client defaults
 * like a date input's initial value: a UTC "today" would already be
 * tomorrow on a Canadian evening.
 */
export const todayDateKey = (now: Date = new Date()): string =>
  `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
