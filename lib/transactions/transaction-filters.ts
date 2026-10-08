import type { FrontendTransaction } from '@/lib/services/transactions';

export type TransactionFilters = {
  from: string | null; // yyyy-mm-dd
  to: string | null;
  accountIds: string[];
  categoryIds: string[];
  payee: string; // contains match, case-insensitive; '' = no filter
  type: 'INCOME' | 'EXPENSE' | null;
  amountMin: string | null;
  amountMax: string | null;
  hideTransfers: boolean;
  hidePayments: boolean;
  uncategorizedOnly: boolean;
  pendingReimbursementsOnly: boolean; // reimbursable expenses still awaiting money (PENDING/PARTIAL)
};

export const DEFAULT_TRANSACTION_FILTERS: TransactionFilters = {
  from: null,
  to: null,
  accountIds: [],
  categoryIds: [],
  payee: '',
  type: null,
  amountMin: null,
  amountMax: null,
  hideTransfers: false,
  hidePayments: false,
  uncategorizedOnly: false,
  pendingReimbursementsOnly: false,
};

const pad2 = (n: number): string => String(n).padStart(2, '0');

/**
 * First and last day (yyyy-mm-dd) of the month containing `now`, in local
 * time on purpose: this is the viewer's "this month", unlike stored
 * transaction dates, which are UTC calendar days (see lib/date.ts).
 */
export const getCurrentMonthRange = (now: Date = new Date()): { from: string; to: string } => {
  const year = now.getFullYear();
  const month = now.getMonth();
  const lastDay = new Date(year, month + 1, 0).getDate();
  return {
    from: `${year}-${pad2(month + 1)}-01`,
    to: `${year}-${pad2(month + 1)}-${pad2(lastDay)}`,
  };
};

const splitIds = (value: string | null): string[] =>
  value
    ? value
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean)
    : [];

/** Reads filter state back out of `?accountIds=...&...` — the inverse of
 * {@link transactionFiltersToSearchParams}. Unknown/malformed values fall
 * back to "no filter" rather than throwing, since a hand-edited or stale URL
 * must never crash the page. */
export const parseTransactionFilters = (params: URLSearchParams): TransactionFilters => {
  const type = params.get('type');
  return {
    from: params.get('from') || null,
    to: params.get('to') || null,
    accountIds: splitIds(params.get('accountIds')),
    categoryIds: splitIds(params.get('categoryIds')),
    payee: params.get('payee') ?? '',
    type: type === 'INCOME' || type === 'EXPENSE' ? type : null,
    amountMin: params.get('amountMin') || null,
    amountMax: params.get('amountMax') || null,
    hideTransfers: params.get('hideTransfers') === 'true',
    hidePayments: params.get('hidePayments') === 'true',
    uncategorizedOnly: params.get('uncategorizedOnly') === 'true',
    pendingReimbursementsOnly: params.get('pendingReimbursementsOnly') === 'true',
  };
};

/** Serializes filter state to URL query params, omitting every field still
 * at its default so an unfiltered view keeps a clean URL rather than a
 * string of empty params. */
export const transactionFiltersToSearchParams = (filters: TransactionFilters): URLSearchParams => {
  const params = new URLSearchParams();
  if (filters.from) params.set('from', filters.from);
  if (filters.to) params.set('to', filters.to);
  if (filters.accountIds.length > 0) params.set('accountIds', filters.accountIds.join(','));
  if (filters.categoryIds.length > 0) params.set('categoryIds', filters.categoryIds.join(','));
  if (filters.payee.trim()) params.set('payee', filters.payee);
  if (filters.type) params.set('type', filters.type);
  if (filters.amountMin) params.set('amountMin', filters.amountMin);
  if (filters.amountMax) params.set('amountMax', filters.amountMax);
  if (filters.hideTransfers) params.set('hideTransfers', 'true');
  if (filters.hidePayments) params.set('hidePayments', 'true');
  if (filters.uncategorizedOnly) params.set('uncategorizedOnly', 'true');
  if (filters.pendingReimbursementsOnly) params.set('pendingReimbursementsOnly', 'true');
  return params;
};

/** Counts active filter *groups*, not selected values — three selected
 * accounts is one active group, matching the "Filters (1)" badge, not a
 * count of every individual checkbox. The payee search box and the date
 * range are excluded: both live outside the filter dialog this badge is for
 * (the date range is the page's period selector). */
export const countActiveFilterGroups = (filters: TransactionFilters): number =>
  [
    filters.accountIds.length > 0,
    filters.categoryIds.length > 0,
    !!filters.type,
    !!(filters.amountMin || filters.amountMax),
    filters.hideTransfers,
    filters.hidePayments,
    filters.uncategorizedOnly,
    filters.pendingReimbursementsOnly,
  ].filter(Boolean).length;

/** A `/transactions` link pre-filtered to `filters` — used by drill-downs
 * from Budgets and Trends. Unset fields stay at their defaults. */
export const transactionsHref = (filters: Partial<TransactionFilters>): string => {
  const query = transactionFiltersToSearchParams({
    ...DEFAULT_TRANSACTION_FILTERS,
    ...filters,
  }).toString();
  return query ? `/transactions?${query}` : '/transactions';
};

/** Every clause a transaction must pass to remain visible under the current
 * filters, including the period selector's `from`/`to` (the credit card
 * statement view writes into the same pair).
 * Off the render path; kept as the reference `buildTransactionWhere` is
 * parity-tested against. */
export const matchesTransactionFilters = (
  transaction: FrontendTransaction,
  filters: TransactionFilters,
): boolean => {
  const payee = filters.payee.trim().toLowerCase();
  if (payee && !(transaction.payee ?? '').toLowerCase().includes(payee)) return false;

  if (filters.accountIds.length > 0 && !filters.accountIds.includes(transaction.accountId)) {
    return false;
  }
  if (
    filters.categoryIds.length > 0 &&
    (!transaction.categoryId || !filters.categoryIds.includes(transaction.categoryId))
  ) {
    return false;
  }

  const day = transaction.date.slice(0, 10);
  if (filters.from && day < filters.from) return false;
  if (filters.to && day > filters.to) return false;

  if (filters.type && transaction.type !== filters.type) return false;

  const amount = Number(transaction.amount);
  const amountMin = filters.amountMin === null ? null : Number(filters.amountMin);
  const amountMax = filters.amountMax === null ? null : Number(filters.amountMax);
  if (amountMin !== null && Number.isFinite(amountMin) && amount < amountMin) return false;
  if (amountMax !== null && Number.isFinite(amountMax) && amount > amountMax) return false;

  if (filters.hideTransfers && transaction.isTransfer) return false;
  if (filters.hidePayments && transaction.isPayment) return false;
  if (filters.uncategorizedOnly && transaction.categoryId) return false;
  if (
    filters.pendingReimbursementsOnly &&
    transaction.reimbursementStatus !== 'PENDING' &&
    transaction.reimbursementStatus !== 'PARTIAL'
  ) {
    return false;
  }

  return true;
};
