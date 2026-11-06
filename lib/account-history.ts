import { monthOfDate, monthRange, shiftMonth } from '@/lib/date';

/**
 * Month-end balance math for the account history charts. Pure, so the
 * services only fetch rows and the rules live (and are tested) here.
 * Amounts are summed in cents to avoid float drift across many rows.
 */

export type HistoryRange = 6 | 12 | 24;

export const HISTORY_RANGES: HistoryRange[] = [6, 12, 24];

export const DEFAULT_HISTORY_RANGE: HistoryRange = 12;

export const parseHistoryRange = (value: unknown): HistoryRange => {
  const n = Number(value);
  return HISTORY_RANGES.includes(n as HistoryRange) ? (n as HistoryRange) : DEFAULT_HISTORY_RANGE;
};

/** `range` consecutive YYYYMM months ending at (and including) `endMonth`. */
export const historyMonths = (endMonth: number, range: number): number[] =>
  Array.from({ length: range }, (_, i) => shiftMonth(endMonth, i - range + 1));

const toCents = (value: unknown): number => Math.round(Number(value) * 100);

type SignedRow = { amount: unknown; type: string; date: Date };

/**
 * Balance at the end of each month for a transaction account: starting
 * balance plus every signed transaction dated before the next month. Null for
 * months before the account had any data (the earlier of its creation month
 * and its first transaction's month), so a chart doesn't draw a flat line
 * through time the account didn't exist in.
 */
export const transactionAccountMonthlyBalances = (
  account: { startingBalance: unknown; createdAt: Date },
  transactions: SignedRow[],
  months: number[],
): (number | null)[] => {
  const firstTxMonth = transactions.reduce(
    (min, t) => Math.min(min, monthOfDate(t.date)),
    Number.POSITIVE_INFINITY,
  );
  const firstMonth = Math.min(monthOfDate(account.createdAt), firstTxMonth);
  const starting = toCents(account.startingBalance);

  return months.map((month) => {
    if (month < firstMonth) return null;
    const { end } = monthRange(month);
    const cents = transactions.reduce((sum, t) => {
      if (t.date >= end) return sum;
      const amount = toCents(t.amount);
      return sum + (t.type === 'INCOME' ? amount : -amount);
    }, starting);
    return cents / 100;
  });
};

type BalanceUpdateRow = { balance: unknown; date: Date; createdAt: Date };

/** Latest update by date, ties broken by the one logged last. */
export const latestBalanceUpdate = <T extends BalanceUpdateRow>(updates: T[]): T | null =>
  updates.reduce<T | null>((latest, u) => {
    if (!latest) return u;
    const byDate = u.date.getTime() - latest.date.getTime();
    if (byDate !== 0) return byDate > 0 ? u : latest;
    return u.createdAt > latest.createdAt ? u : latest;
  }, null);

/**
 * Balance at the end of each month for a balance-tracked account: the latest
 * update dated on or before that month's end. Null before the first update.
 */
export const trackedAccountMonthlyBalances = (
  updates: BalanceUpdateRow[],
  months: number[],
): (number | null)[] =>
  months.map((month) => {
    const { end } = monthRange(month);
    const latest = latestBalanceUpdate(updates.filter((u) => u.date < end));
    return latest ? toCents(latest.balance) / 100 : null;
  });

export type BalanceChange = { amount: number; percent: number | null };

/** Change from the first known balance in the range to the last; null with
 * fewer than two months of data. Percent is null when the start is 0, where a
 * ratio means nothing. */
export const balanceChange = (balances: (number | null)[]): BalanceChange | null => {
  const known = balances.filter((b): b is number => b !== null);
  if (known.length < 2) return null;
  const first = known[0]!;
  const last = known[known.length - 1]!;
  const amount = Math.round((last - first) * 100) / 100;
  return { amount, percent: first === 0 ? null : (amount / Math.abs(first)) * 100 };
};
