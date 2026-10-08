import { isLiabilityAccountType } from '@/lib/account-types';

/**
 * CSV sign convention differs by account type: checking/savings/cash
 * exports use the debit convention (negative = money out = expense);
 * credit card/line-of-credit exports are inverted (positive = a charge =
 * expense, negative = a payment or refund credited back = income).
 */
export const resolveImportedTransactionType = (
  amount: number,
  accountType: string,
): 'INCOME' | 'EXPENSE' => {
  const isExpense = isLiabilityAccountType(accountType) ? amount > 0 : amount < 0;
  return isExpense ? 'EXPENSE' : 'INCOME';
};

/**
 * Bank exports format amounts loosely: "$1,234.56", "1 234.56", "(45.00)" for
 * a negative, or an empty cell. Returns null for a blank or unparseable cell
 * rather than NaN, so callers can tell "no value" from zero.
 */
export const parseCsvAmount = (raw: string | undefined): number | null => {
  if (raw === undefined) return null;
  let text = raw.trim();
  if (!text) return null;
  let negative = false;
  if (text.startsWith('(') && text.endsWith(')')) {
    negative = true;
    text = text.slice(1, -1);
  }
  const cleaned = text.replace(/[^0-9.+-]/g, '');
  if (!cleaned || !/\d/.test(cleaned)) return null;
  const value = Number(cleaned);
  if (!Number.isFinite(value)) return null;
  return negative ? -Math.abs(value) : value;
};

/**
 * For exports that split money in and money out into two columns instead of
 * one signed amount. The credit column is money into the account (income, or
 * a payment/refund on a credit card), the debit column is money out
 * (spending, or a charge on a card), so no sign convention or account type
 * is involved. Cells are read as magnitudes, since some banks write debits as
 * negatives. Returns null when neither column has a value (e.g. a balance or
 * pending line), so the row can be dropped.
 */
export const resolveSplitColumnAmount = (
  creditRaw: string | undefined,
  debitRaw: string | undefined,
): { amount: number; type: 'INCOME' | 'EXPENSE' } | null => {
  const credit = Math.abs(parseCsvAmount(creditRaw) ?? 0);
  const debit = Math.abs(parseCsvAmount(debitRaw) ?? 0);
  if (credit === 0 && debit === 0) return null;
  // both filled is rare (a fee netted against a deposit); import the net
  const net = credit - debit;
  return { amount: Math.abs(net), type: net >= 0 ? 'INCOME' : 'EXPENSE' };
};

/** Header guesses for the split-column layout. */
export const guessSplitColumns = (headers: string[]): { credit: string; debit: string } => {
  const find = (needles: string[]): string =>
    headers.find((h) => needles.some((n) => h.toLowerCase().includes(n))) ?? '';
  return {
    credit: find(['credit', 'deposit', 'money in', 'paid in']),
    debit: find(['debit', 'withdrawal', 'spending', 'money out', 'paid out']),
  };
};
