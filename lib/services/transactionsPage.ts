import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db/prisma';
import { ServiceValidationError } from '@/lib/services/common';
import {
  fromCents,
  getReimbursementsInExpenseMonth,
  listPendingReimbursementExpenseIds,
  toCents,
} from '@/lib/services/reimbursements';
import { include, toFrontend, type FrontendTransaction } from '@/lib/services/transactions';
import {
  compareTransactionOrder,
  dayKey,
  decodeTransactionCursor,
  encodeTransactionCursor,
  isAmountSubstringCandidate,
  isOlderThanCursor,
  needsExactStringMatch,
  type TransactionCursor,
  type TransactionScope,
} from '@/lib/transactions/transaction-scope';
import type { TransactionFilters } from '@/lib/transactions/transaction-filters';
import { parseDateParam, rangeToDates } from '@/lib/period-selection';
import { summarizeTransactions } from '@/lib/transactions/transaction-summary';
import type { TransactionsPageQuery } from '@/lib/validators/transactions';

/**
 * Paginated Transactions read: one page of rows plus the scope's aggregates,
 * all from one where-builder so they can't drift. Money is summed in cents and
 * returned as `toFixed(2)` strings.
 */

export type TransactionsPageRequest = TransactionScope & {
  limit: number;
  /** previous page's `nextCursor`; absent = first page */
  cursor?: string;
};

export type TransactionSummary = {
  credit: string;
  debit: string;
  payments: string;
  transfers: string;
  paymentsIncome: string;
  transfersIncome: string;
  reimbursementIncome: string;
  net: string;
};

/** Signed day total, keyed by UTC `YYYY-MM-DD`. */
export type DayTotal = { day: string; total: string };

export type TransactionsPageResult = {
  /** newest first: `(date desc, id desc)` */
  rows: FrontendTransaction[];
  nextCursor: string | null;
  hasMore: boolean;
  /** signed total of every in-scope row older than this page */
  runningBalanceStart: string;
  /** includes mobile search */
  totalCount: number;
  /** excludes mobile search */
  desktopCount: number;
  /** uncategorized rows, ignoring the pill filters (`type`/`uncategorizedOnly`) */
  uncategorizedCount: number;
  /** excludes mobile search */
  summary: TransactionSummary;
  /** includes mobile search */
  mobileSummary: TransactionSummary;
  /** full-day totals for each day this page touches */
  dayTotals: DayTotal[];
};

const ORDER_BY: Prisma.TransactionOrderByWithRelationInput[] = [{ date: 'desc' }, { id: 'desc' }];
const DAY_MS = 24 * 60 * 60 * 1000;

const signedCents = (type: string, amount: unknown): number =>
  type === 'INCOME' ? toCents(amount) : -toCents(amount);

const finiteAmount = (value: string | null): number | null => {
  if (value === null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

/** Payee term safe for Prisma `contains` (no LIKE metacharacters). */
const prismaSafePayee = (filters: TransactionFilters): string | null => {
  const term = filters.payee.trim();
  return term && !needsExactStringMatch(term) ? term : null;
};

/** Mobile search term that can only match payee, so Prisma can handle it. */
const prismaSafeMobileSearch = (mobileSearch: string): string | null => {
  const term = mobileSearch.trim();
  return term && !isAmountSubstringCandidate(term) && !needsExactStringMatch(term) ? term : null;
};

export type BuildWhereOptions = {
  mobile: boolean;
  /** required with `pendingReimbursementsOnly` */
  pendingReimbursementIds?: string[];
};

/** A text term must be matched in JS (Mode B). */
const needsModeB = (scope: TransactionScope): boolean =>
  (scope.filters.payee.trim() !== '' && !prismaSafePayee(scope.filters)) ||
  (scope.mobileSearch.trim() !== '' && !prismaSafeMobileSearch(scope.mobileSearch));

/** Scope without the pill filters, so the Uncategorized badge ignores them. */
const withoutPillFilters = (scope: TransactionScope): TransactionScope => ({
  ...scope,
  filters: { ...scope.filters, type: null, uncategorizedOnly: false },
});

/**
 * The predicate behind the page query and every aggregate. `mobile: false`
 * omits mobile search (the desktop scope).
 *
 * - Clauses go in one `AND` array; top-level keys would overwrite each other.
 * - Terms Prisma can't express (amount-shaped search, `%`/`_`) are left out and
 *   matched in JS by Mode B.
 * - Pending reimbursement status is derived, so the caller passes matching ids.
 * - No `skippedAt` clause: skipped rows stay visible.
 */
export const buildTransactionWhere = (
  userId: string,
  scope: TransactionScope,
  options: BuildWhereOptions,
): Prisma.TransactionWhereInput => {
  const { filters } = scope;
  const and: Prisma.TransactionWhereInput[] = [];

  const payee = prismaSafePayee(filters);
  if (payee) and.push({ payee: { contains: payee, mode: 'insensitive' } });
  if (filters.accountIds.length > 0) and.push({ accountId: { in: filters.accountIds } });
  // `in` never matches NULL, so uncategorized rows are excluded
  if (filters.categoryIds.length > 0) and.push({ categoryId: { in: filters.categoryIds } });

  const dates = rangeToDates({
    from: parseDateParam(filters.from),
    to: parseDateParam(filters.to),
  });
  if (dates.gte) and.push({ date: { gte: dates.gte } });
  if (dates.lt) and.push({ date: { lt: dates.lt } });

  if (filters.type) and.push({ type: filters.type });
  const amountMin = finiteAmount(filters.amountMin);
  if (amountMin !== null) and.push({ amount: { gte: amountMin } });
  const amountMax = finiteAmount(filters.amountMax);
  if (amountMax !== null) and.push({ amount: { lte: amountMax } });
  if (filters.hideTransfers) and.push({ isTransfer: false });
  if (filters.hidePayments) and.push({ isPayment: false });
  if (filters.uncategorizedOnly) and.push({ categoryId: null });
  if (filters.pendingReimbursementsOnly) {
    if (!options.pendingReimbursementIds) {
      throw new Error('pendingReimbursementIds is required when pendingReimbursementsOnly is set');
    }
    and.push({ id: { in: options.pendingReimbursementIds } });
  }

  if (options.mobile) {
    const search = prismaSafeMobileSearch(scope.mobileSearch);
    if (search) and.push({ payee: { contains: search, mode: 'insensitive' } });
  }

  return and.length > 0 ? { userId, AND: and } : { userId };
};

/** JS half of the payee filter; `true` when Prisma already applied it. */
export const matchesDeferredPayee = (
  payee: string | null,
  filters: TransactionFilters,
): boolean => {
  const term = filters.payee.trim();
  if (!term || prismaSafePayee(filters)) return true;
  return (payee ?? '').toLowerCase().includes(term.toLowerCase());
};

export const toTransactionsPageRequest = (
  query: TransactionsPageQuery,
): TransactionsPageRequest => ({
  filters: {
    from: query.from ?? null,
    to: query.to ?? null,
    accountIds: query.accountIds,
    categoryIds: query.categoryIds,
    payee: query.payee,
    type: query.type ?? null,
    amountMin: query.amountMin ?? null,
    amountMax: query.amountMax ?? null,
    hideTransfers: query.hideTransfers,
    hidePayments: query.hidePayments,
    uncategorizedOnly: query.uncategorizedOnly,
    pendingReimbursementsOnly: query.pendingReimbursementsOnly,
  },
  mobileSearch: query.mobileSearch,
  limit: query.limit,
  cursor: query.cursor,
});

/** Rows strictly older than `cursor`. */
const olderThan = (cursor: TransactionCursor): Prisma.TransactionWhereInput => ({
  OR: [{ date: { lt: cursor.date } }, { date: cursor.date, id: { lt: cursor.id } }],
});

/** Columns `summarizeTransactions` needs, without display relations. */
const SUMMARY_SELECT = {
  amount: true,
  type: true,
  isPayment: true,
  isTransfer: true,
  isReimbursable: true,
  reimbursementExpectedAmount: true,
  reimbursementCompletedAt: true,
  reimbursementExpenseLinks: { select: { amount: true } },
  reimbursementIncomeLinks: { select: { amount: true } },
} as const;

type SummaryRow = {
  amount: unknown;
  type: string;
  isPayment: boolean;
  isTransfer: boolean;
  isReimbursable: boolean;
  reimbursementExpectedAmount: unknown;
  reimbursementCompletedAt: Date | null;
  reimbursementExpenseLinks: { amount: unknown }[];
  reimbursementIncomeLinks: { amount: unknown }[];
};

const sumLinks = (links: { amount: unknown }[]): string =>
  fromCents(links.reduce((sum, l) => sum + toCents(l.amount), 0));

/** Reimbursement-netted totals; needs per-row fields, so no `groupBy`. */
const summarizeRows = (rows: SummaryRow[], inExpenseMonth: boolean): TransactionSummary => {
  const totals = summarizeTransactions(
    rows.map((r) => ({
      amount: fromCents(toCents(r.amount)),
      type: r.type as FrontendTransaction['type'],
      isPayment: r.isPayment,
      isTransfer: r.isTransfer,
      isReimbursementIncome: r.reimbursementIncomeLinks.length > 0,
      isReimbursable: r.isReimbursable,
      reimbursementExpectedAmount:
        r.reimbursementExpectedAmount == null
          ? null
          : fromCents(toCents(r.reimbursementExpectedAmount)),
      reimbursementLinkedTotal: sumLinks(r.reimbursementExpenseLinks),
      reimbursementCompletedManually: r.reimbursementCompletedAt !== null,
      reimbursementIncomeLinkedTotal: sumLinks(r.reimbursementIncomeLinks),
    })),
    { inExpenseMonth },
  );
  return {
    credit: totals.credit.toFixed(2),
    debit: totals.debit.toFixed(2),
    payments: totals.payments.toFixed(2),
    transfers: totals.transfers.toFixed(2),
    paymentsIncome: totals.paymentsIncome.toFixed(2),
    transfersIncome: totals.transfersIncome.toFixed(2),
    reimbursementIncome: totals.reimbursementIncome.toFixed(2),
    net: totals.net.toFixed(2),
  };
};

/** Totals and row count from one scan. */
const summarize = async (
  where: Prisma.TransactionWhereInput,
  inExpenseMonth: boolean,
): Promise<{ summary: TransactionSummary; count: number }> => {
  const rows = (await prisma.transaction.findMany({
    where,
    select: SUMMARY_SELECT,
  })) as SummaryRow[];
  return { summary: summarizeRows(rows, inExpenseMonth), count: rows.length };
};

const toDayTotals = (byDay: Map<string, number>): DayTotal[] =>
  [...byDay.entries()]
    .sort(([a], [b]) => (a < b ? 1 : a > b ? -1 : 0))
    .map(([day, cents]) => ({ day, total: fromCents(cents) }));

/** `[start, end)` of the UTC days a page spans. */
const pageDayWindow = (rows: { date: Date }[]): { start: Date; end: Date } => {
  const start = new Date(`${dayKey(rows[rows.length - 1].date)}T00:00:00.000Z`);
  const end = new Date(new Date(`${dayKey(rows[0].date)}T00:00:00.000Z`).getTime() + DAY_MS);
  return { start, end };
};

type PageAggregates = Pick<
  TransactionsPageResult,
  'totalCount' | 'desktopCount' | 'uncategorizedCount' | 'summary' | 'mobileSummary'
>;

const toPageResult = (
  rows: Parameters<typeof toFrontend>[0][],
  page: { hasMore: boolean; runningBalanceCents: number; byDay: Map<string, number> },
  aggregates: PageAggregates,
): TransactionsPageResult => {
  const oldest = rows[rows.length - 1];
  return {
    rows: rows.map(toFrontend),
    nextCursor:
      page.hasMore && oldest ? encodeTransactionCursor({ date: oldest.date, id: oldest.id }) : null,
    hasMore: page.hasMore,
    runningBalanceStart: fromCents(page.runningBalanceCents),
    dayTotals: toDayTotals(page.byDay),
    ...aggregates,
  };
};

const EMPTY_PAGE = { hasMore: false, runningBalanceCents: 0, byDay: new Map<string, number>() };

/** Mode A: everything in Prisma. Balance and day totals need the page rows, so they run second. */
const getPageModeA = async (
  userId: string,
  request: TransactionsPageRequest,
  cursor: TransactionCursor | null,
  pendingReimbursementIds: string[] | undefined,
  inExpenseMonth: boolean,
): Promise<TransactionsPageResult> => {
  const where = buildTransactionWhere(userId, request, {
    mobile: true,
    pendingReimbursementIds,
  });
  const mobileDefaults = request.mobileSearch.trim() === '';
  const desktopWhere = mobileDefaults
    ? where
    : buildTransactionWhere(userId, request, { mobile: false, pendingReimbursementIds });
  const pillFreeWhere = buildTransactionWhere(userId, withoutPillFilters(request), {
    mobile: false,
    pendingReimbursementIds,
  });

  const [found, uncategorizedCount, desktop, mobileOrNull] = await Promise.all([
    prisma.transaction.findMany({
      where: cursor ? { AND: [where, olderThan(cursor)] } : where,
      include,
      orderBy: ORDER_BY,
      take: request.limit + 1,
    }),
    prisma.transaction.count({ where: { AND: [pillFreeWhere, { categoryId: null }] } }),
    summarize(desktopWhere, inExpenseMonth),
    mobileDefaults ? Promise.resolve(null) : summarize(where, inExpenseMonth),
  ]);
  const mobile = mobileOrNull ?? desktop;

  const hasMore = found.length > request.limit;
  const rows = hasMore ? found.slice(0, request.limit) : found;
  const base = {
    totalCount: mobile.count,
    desktopCount: desktop.count,
    uncategorizedCount,
    summary: desktop.summary,
    mobileSummary: mobile.summary,
  };
  if (rows.length === 0) return toPageResult([], EMPTY_PAGE, base);

  const oldest = rows[rows.length - 1];
  const window = pageDayWindow(rows);
  const [olderByType, dayRows] = (await Promise.all([
    prisma.transaction.groupBy({
      by: ['type'],
      where: { AND: [where, olderThan(oldest)] },
      _sum: { amount: true },
    }),
    prisma.transaction.groupBy({
      by: ['date', 'type'],
      where: { AND: [where, { date: { gte: window.start, lt: window.end } }] },
      _sum: { amount: true },
    }),
  ])) as unknown as [
    { type: string; _sum: { amount: unknown } }[],
    { date: Date; type: string; _sum: { amount: unknown } }[],
  ];

  const runningBalanceCents = olderByType.reduce(
    (sum, r) => sum + signedCents(r.type, r._sum.amount ?? 0),
    0,
  );
  const byDay = new Map<string, number>();
  for (const r of dayRows) {
    const key = dayKey(r.date);
    byDay.set(key, (byDay.get(key) ?? 0) + signedCents(r.type, r._sum.amount ?? 0));
  }

  return toPageResult(rows, { hasMore, runningBalanceCents, byDay }, base);
};

type ScanRow = SummaryRow & {
  id: string;
  date: Date;
  payee: string | null;
  categoryId: string | null;
};

/**
 * Mode B: one lean scan of the scope, text terms and aggregates in JS, then
 * only the page rows are hydrated.
 */
const getPageModeB = async (
  userId: string,
  request: TransactionsPageRequest,
  cursor: TransactionCursor | null,
  pendingReimbursementIds: string[] | undefined,
  inExpenseMonth: boolean,
): Promise<TransactionsPageResult> => {
  // Pill filters are skipped here so the same scan counts the badge; applied in JS below.
  const scan = (await prisma.transaction.findMany({
    where: buildTransactionWhere(userId, withoutPillFilters(request), {
      mobile: false,
      pendingReimbursementIds,
    }),
    select: { id: true, date: true, payee: true, categoryId: true, ...SUMMARY_SELECT },
  })) as ScanRow[];

  const { type, uncategorizedOnly } = request.filters;
  const searchLower = request.mobileSearch.trim().toLowerCase();
  // sorted in JS so the order matches the keyset comparator exactly
  const pillFree = scan
    .filter((r) => matchesDeferredPayee(r.payee, request.filters))
    .sort(compareTransactionOrder);
  const desktop = pillFree.filter(
    (r) => (!type || r.type === type) && (!uncategorizedOnly || !r.categoryId),
  );
  const full = desktop.filter((r) => {
    if (!searchLower) return true;
    // payee OR formatted amount
    return (
      (r.payee ?? '').toLowerCase().includes(searchLower) ||
      Number(r.amount).toFixed(2).includes(searchLower)
    );
  });

  const base = {
    totalCount: full.length,
    desktopCount: desktop.length,
    uncategorizedCount: pillFree.filter((r) => !r.categoryId).length,
    summary: summarizeRows(desktop, inExpenseMonth),
    mobileSummary: summarizeRows(full, inExpenseMonth),
  };

  const after = cursor ? full.filter((r) => isOlderThanCursor(r, cursor)) : full;
  const pageRows = after.slice(0, request.limit);
  const hasMore = after.length > request.limit;
  if (pageRows.length === 0) return toPageResult([], EMPTY_PAGE, base);

  const hydrated = await prisma.transaction.findMany({
    where: { userId, id: { in: pageRows.map((r) => r.id) } },
    include,
  });
  // `in` doesn't preserve order
  const position = new Map(pageRows.map((r, i) => [r.id, i]));
  const rows = hydrated
    .filter((r) => position.has(r.id))
    .sort((a, b) => position.get(a.id)! - position.get(b.id)!);

  const oldest = pageRows[pageRows.length - 1];
  const window = pageDayWindow(pageRows);
  let runningBalanceCents = 0;
  const byDay = new Map<string, number>();
  for (const r of full) {
    const signed = signedCents(r.type, r.amount);
    if (isOlderThanCursor(r, oldest)) runningBalanceCents += signed;
    if (r.date >= window.start && r.date < window.end) {
      const key = dayKey(r.date);
      byDay.set(key, (byDay.get(key) ?? 0) + signed);
    }
  }

  return toPageResult(rows, { hasMore, runningBalanceCents, byDay }, base);
};

export const getTransactionsPage = async (
  userId: string,
  request: TransactionsPageRequest,
): Promise<TransactionsPageResult> => {
  let cursor: TransactionCursor | null = null;
  if (request.cursor !== undefined) {
    cursor = decodeTransactionCursor(request.cursor);
    if (!cursor) throw new ServiceValidationError('Invalid cursor');
  }
  const [pendingReimbursementIds, inExpenseMonth] = await Promise.all([
    request.filters.pendingReimbursementsOnly
      ? listPendingReimbursementExpenseIds(userId)
      : Promise.resolve(undefined),
    getReimbursementsInExpenseMonth(userId),
  ]);
  return needsModeB(request)
    ? getPageModeB(userId, request, cursor, pendingReimbursementIds, inExpenseMonth)
    : getPageModeA(userId, request, cursor, pendingReimbursementIds, inExpenseMonth);
};
