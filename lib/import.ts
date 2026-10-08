import { isLiabilityAccountType } from '@/lib/account-types';
import { fromDateKey } from '@/lib/date';

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

/**
 * Order of the numeric parts in a CSV date column: year-month-day
 * (`2026-10-05`, `20261005`), month-day-year (`10/05/2026`, US banks) or
 * day-month-year (`05/10/2026`, many Canadian and UK banks).
 */
export type CsvDateFormat = 'YMD' | 'MDY' | 'DMY';

export const CSV_DATE_FORMATS: { value: CsvDateFormat; label: string }[] = [
  { value: 'YMD', label: 'YYYY-MM-DD' },
  { value: 'MDY', label: 'MM/DD/YYYY' },
  { value: 'DMY', label: 'DD/MM/YYYY' },
];

const MONTH_NAMES = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
];

/** 1-12 for `Oct`, `October`, `Sept.` and so on, else null. */
const monthFromName = (word: string): number | null => {
  const name = word.toLowerCase().replace(/\.$/, '');
  if (name.length < 3) return null;
  const index = MONTH_NAMES.findIndex(
    (m) => m.startsWith(name) || (name === 'sept' && m === 'september'),
  );
  return index === -1 ? null : index + 1;
};

const toKey = (year: number, month: number, day: number): string | null => {
  if (year < 1900 || year > 2999) return null;
  const key = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return fromDateKey(key) ? key : null;
};

/** two-digit years are this century: `10/05/26` is 2026 */
const fullYear = (raw: string): number => (raw.length === 2 ? 2000 + Number(raw) : Number(raw));

// A date may be followed by a time (`2026-10-05 13:45`, `10/05/2026T08:00`),
// which is ignored: the bank's calendar day is what gets stored.
const END = String.raw`(?=$|[T\s,])`;
const NUMERIC = new RegExp(String.raw`^(\d{1,4})[-/.](\d{1,2})[-/.](\d{1,4})${END}`);
const COMPACT = new RegExp(String.raw`^(\d{4})(\d{2})(\d{2})${END}`);
const NAME_DAY_YEAR = new RegExp(
  String.raw`^([A-Za-z]{3,9}\.?)[\s\-/.]+(\d{1,2})(?:st|nd|rd|th)?,?[\s\-/.]+(\d{4}|\d{2})${END}`,
);
const DAY_NAME_YEAR = new RegExp(
  String.raw`^(\d{1,2})[\s\-/.]+([A-Za-z]{3,9}\.?)[\s\-/.,]+(\d{4}|\d{2})${END}`,
);
const YEAR_NAME_DAY = new RegExp(
  String.raw`^(\d{4})[\s\-/.]+([A-Za-z]{3,9}\.?)[\s\-/.]+(\d{1,2})${END}`,
);

/**
 * A bank CSV date cell as a `YYYY-MM-DD` calendar date, or null when it does
 * not read as a real date in `format`. Month-name dates (`Oct 5, 2026`,
 * `05-Oct-2026`) are unambiguous and parse under any format. Never goes
 * through `new Date(raw)`, which reads non-ISO strings in the host's local
 * timezone and always assumes month-first.
 */
export const parseCsvDate = (raw: string | undefined, format: CsvDateFormat): string | null => {
  const text = raw?.trim() ?? '';
  if (!text) return null;

  const named = NAME_DAY_YEAR.exec(text);
  if (named) {
    const month = monthFromName(named[1]);
    return month ? toKey(fullYear(named[3]), month, Number(named[2])) : null;
  }
  const dayNamed = DAY_NAME_YEAR.exec(text);
  if (dayNamed) {
    const month = monthFromName(dayNamed[2]);
    return month ? toKey(fullYear(dayNamed[3]), month, Number(dayNamed[1])) : null;
  }
  const yearNamed = YEAR_NAME_DAY.exec(text);
  if (yearNamed) {
    const month = monthFromName(yearNamed[2]);
    return month ? toKey(Number(yearNamed[1]), month, Number(yearNamed[3])) : null;
  }

  const compact = COMPACT.exec(text);
  if (compact) {
    return format === 'YMD'
      ? toKey(Number(compact[1]), Number(compact[2]), Number(compact[3]))
      : null;
  }

  const numeric = NUMERIC.exec(text);
  if (!numeric) return null;
  const [, a, b, c] = numeric;
  if (format === 'YMD') {
    return a.length === 4 ? toKey(Number(a), Number(b), Number(c)) : null;
  }
  if (a.length > 2 || (c.length !== 2 && c.length !== 4)) return null;
  return format === 'MDY'
    ? toKey(fullYear(c), Number(a), Number(b))
    : toKey(fullYear(c), Number(b), Number(a));
};

export type CsvDateDetection =
  | { kind: 'detected'; format: CsvDateFormat }
  /** every value reads as a real date both month-first and day-first */
  | { kind: 'ambiguous'; options: CsvDateFormat[] }
  | { kind: 'unrecognized' };

/**
 * Picks the format that reads the most values in a date column as real
 * dates, so one stray footer line ("Total") doesn't sink detection. A
 * `13/02/2026` anywhere settles day-first; when month-first and day-first
 * read every value equally well, the user has to choose.
 */
export const detectCsvDateFormat = (values: (string | undefined)[]): CsvDateDetection => {
  const counts = CSV_DATE_FORMATS.map(({ value }) => ({
    format: value,
    parsed: values.filter((v) => parseCsvDate(v, value) !== null).length,
  }));
  const best = Math.max(...counts.map((c) => c.parsed));
  if (best === 0) return { kind: 'unrecognized' };
  const winners = counts.filter((c) => c.parsed === best).map((c) => c.format);
  // all three tie only when every date is month-named, where order is moot
  if (winners.length === 1 || winners.length === CSV_DATE_FORMATS.length) {
    return { kind: 'detected', format: winners[0] };
  }
  return { kind: 'ambiguous', options: winners };
};
