import { shiftMonth } from '@/lib/date';

/**
 * Pure helpers for spreading one EXPENSE across several months for reporting.
 * No Prisma here so the transaction form can import them for its live preview.
 */

export const SPREAD_MIN_MONTHS = 2;
export const SPREAD_MAX_MONTHS = 24;
/** how far (in months, either side) the start month may sit from the transaction's month */
export const SPREAD_MAX_START_OFFSET = 24;

export type SpreadShare = { month: number; cents: number };

/** Last `YYYYMM` month covered by a spread starting at `start` for `months` months. */
export const spreadEndMonth = (start: number, months: number): number =>
  shiftMonth(start, months - 1);

/**
 * Splits `amountCents` evenly over `months` months from `start`. The first
 * `amountCents % months` months take one extra cent, so the shares always sum
 * back to the exact amount (`$100 / 3` gives 33.34, 33.33, 33.33).
 */
export const allocateSpread = (
  amountCents: number,
  start: number,
  months: number,
): SpreadShare[] => {
  const base = Math.floor(amountCents / months);
  const remainder = amountCents - base * months;
  return Array.from({ length: months }, (_, i) => ({
    month: shiftMonth(start, i),
    cents: base + (i < remainder ? 1 : 0),
  }));
};
