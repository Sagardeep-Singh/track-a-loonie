import { toDateKey } from '@/lib/date';
import type { TransactionFilters } from '@/lib/transactions/transaction-filters';

/** DB-free scope, ordering and cursor rules for the paginated Transactions read. */

export type TransactionScope = {
  filters: TransactionFilters;
  /** payee OR formatted-amount substring; `''` = none */
  mobileSearch: string;
};

export type TransactionCursor = { date: Date; id: string };

export type OrderedRow = { date: Date; id: string };

/**
 * Newest-first comparator, `(date desc, id desc)`, shared by `orderBy`, the
 * keyset and Mode B. `> 0` means `a` is older than `b`.
 */
export const compareTransactionOrder = (a: OrderedRow, b: OrderedRow): number => {
  const byDate = b.date.getTime() - a.date.getTime();
  if (byDate !== 0) return byDate;
  if (a.id === b.id) return 0;
  return a.id < b.id ? 1 : -1;
};

/** `row` is strictly older than `cursor`. */
export const isOlderThanCursor = (row: OrderedRow, cursor: TransactionCursor): boolean =>
  compareTransactionOrder(row, cursor) > 0;

const toBase64Url = (value: string): string =>
  Buffer.from(value, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

export const encodeTransactionCursor = (cursor: TransactionCursor): string =>
  toBase64Url(JSON.stringify({ d: cursor.date.toISOString(), i: cursor.id }));

/** `null` on malformed input. */
export const decodeTransactionCursor = (raw: string): TransactionCursor | null => {
  if (!raw) return null;
  // Buffer's decoder silently drops stray characters
  if (!/^[A-Za-z0-9_-]+$/.test(raw)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const { d, i } = parsed as { d?: unknown; i?: unknown };
  if (typeof d !== 'string' || typeof i !== 'string' || i === '') return null;
  const date = new Date(d);
  if (Number.isNaN(date.getTime())) return null;
  return { date, id: i };
};

/** Digits/dots only: the exact set of terms that can match `amount.toFixed(2)`. */
export const isAmountSubstringCandidate = (term: string): boolean => /^[0-9.]+$/.test(term.trim());

/** Prisma `contains` doesn't escape LIKE `%`/`_`, so these terms are matched in JS. */
export const needsExactStringMatch = (term: string): boolean =>
  term.includes('%') || term.includes('_');

/** UTC calendar day as `YYYY-MM-DD`, independent of host TZ. */
export const dayKey = (date: Date): string => toDateKey(date);
