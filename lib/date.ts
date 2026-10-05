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
