import { monthRange } from '@/lib/date';
import { prisma } from '@/lib/db/prisma';
import { listReimbursedAmountsByExpenseDate } from '@/lib/services/reimbursements';
import { listSpreadSharesInRange } from '@/lib/services/spreadExpenses';

export type TrendsRange = 3 | 6 | 12;

export type TrendsMonth = { month: number; label: string; income: number; expense: number };

export type TrendsCategory = { categoryId: string; categoryName: string; color: string };

export type TrendsCategoryMonth = {
  month: number;
  segments: { categoryId: string; amount: number }[];
};

export type TrendsMover = {
  categoryId: string;
  categoryName: string;
  current: number;
  prior: number;
  amount: number;
  pctChange: number | null;
  tone: 'rose' | 'sky';
};

export type SpendingTrendsData = {
  range: TrendsRange;
  months: TrendsMonth[];
  categories: TrendsCategory[];
  categoryBreakdown: TrendsCategoryMonth[];
  headline: {
    currentTotal: string;
    priorTotal: string;
    pctChange: number | null;
    currentRangeLabel: string;
    priorRangeLabel: string;
    tone: 'rose' | 'sky' | 'neutral';
  };
  movers: TrendsMover[];
  uncategorizedCount: number;
};

const UNCATEGORIZED_ID = '__uncategorized__';
const OTHER_CATEGORY_ID = '__other__';
const CHART_COLORS = [
  'var(--chart-1)',
  'var(--chart-2)',
  'var(--chart-3)',
  'var(--chart-4)',
  'var(--chart-5)',
  'var(--chart-6)',
];
const MAX_CATEGORY_SLOTS = CHART_COLORS.length;

const MONTH_LABEL = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short' });

const currentMonth = (): number => {
  const now = new Date();
  return now.getUTCFullYear() * 100 + (now.getUTCMonth() + 1);
};

const shiftMonth = (month: number, delta: number): number => {
  const year = Math.floor(month / 100);
  const idx = (month % 100) - 1 + delta;
  const date = new Date(Date.UTC(year, idx, 1));
  return date.getUTCFullYear() * 100 + (date.getUTCMonth() + 1);
};

/** A month's first UTC day — also the label anchor for `MONTH_LABEL`. */
const monthStart = (month: number): Date => monthRange(month).start;

/** Ascending list of `count` months ending at (and including) `endMonth`. */
const monthsEnding = (endMonth: number, count: number): number[] =>
  Array.from({ length: count }, (_, i) => shiftMonth(endMonth, i - (count - 1)));

export const getSpendingTrends = async (
  userId: string,
  options: { month?: number; range?: TrendsRange } = {},
): Promise<SpendingTrendsData> => {
  const range = options.range ?? 3;
  const endMonth = options.month ?? currentMonth();
  const currentMonths = monthsEnding(endMonth, range);
  const priorMonths = monthsEnding(shiftMonth(currentMonths[0], -1), range);
  const allMonths = [...priorMonths, ...currentMonths];

  const rangeStart = monthStart(allMonths[0]);
  // the last month's exclusive upper bound is the next month's first day
  const rangeEndDate = monthRange(allMonths[allMonths.length - 1]).end;

  const [transactions, reimbursedExpenses, spreadShares] = await Promise.all([
    prisma.transaction.findMany({
      where: { userId, date: { gte: rangeStart, lt: rangeEndDate } },
      include: {
        category: { select: { id: true, name: true } },
        reimbursementIncomeLinks: { select: { amount: true } },
      },
    }),
    listReimbursedAmountsByExpenseDate(userId, rangeStart, rangeEndDate),
    listSpreadSharesInRange(userId, allMonths[0], allMonths[allMonths.length - 1]),
  ]);

  // Reimbursed amount per expense — nets out of every expense sum below,
  // mirroring lib/services/budgets.ts, so movers/category totals reflect
  // out-of-pocket spend rather than gross.
  const reimbursedByTransaction = new Map<string, number>();
  for (const r of reimbursedExpenses) {
    reimbursedByTransaction.set(
      r.expenseTransactionId,
      (reimbursedByTransaction.get(r.expenseTransactionId) ?? 0) + Number(r.amount),
    );
  }
  const netExpenseAmount = (t: (typeof transactions)[number]): number =>
    Math.max(0, Number(t.amount) - (reimbursedByTransaction.get(t.id) ?? 0));
  // Only the linked part of a reimbursement income is excluded.
  const netIncomeAmount = (t: (typeof transactions)[number]): number =>
    Math.max(
      0,
      Number(t.amount) - t.reimbursementIncomeLinks.reduce((sum, l) => sum + Number(l.amount), 0),
    );

  const monthOf = (date: Date): number => date.getUTCFullYear() * 100 + (date.getUTCMonth() + 1);

  // Same income/expense filters as getOverviewData: both legs of an
  // inter-account transfer never count as spending or income, and the linked
  // part of an income used as a reimbursement is excluded (live links, not a
  // static flag).
  const isIncome = (t: (typeof transactions)[number]): boolean =>
    t.type === 'INCOME' && !t.isPayment && !t.isTransfer;
  // A spread expense counts through its monthly shares (added below), never
  // through its own date.
  const isExpense = (t: (typeof transactions)[number]): boolean =>
    t.type === 'EXPENSE' && !t.isTransfer && t.spreadMonths == null;

  const monthTotals = new Map<number, { income: number; expense: number }>();
  for (const m of allMonths) monthTotals.set(m, { income: 0, expense: 0 });
  const categoryMonthTotals = new Map<string, Map<number, number>>();
  const categoryNames = new Map<string, string>();
  const currentMonthSet = new Set(currentMonths);
  let uncategorizedCount = 0;

  const addExpense = (
    m: number,
    category: { id: string; name: string } | null,
    amount: number,
    countsUncategorized: boolean,
  ): void => {
    const bucket = monthTotals.get(m);
    if (!bucket) return;
    bucket.expense += amount;
    const categoryId = category?.id ?? UNCATEGORIZED_ID;
    categoryNames.set(categoryId, category?.name ?? 'Uncategorized');
    if (!categoryMonthTotals.has(categoryId)) categoryMonthTotals.set(categoryId, new Map());
    const perMonth = categoryMonthTotals.get(categoryId)!;
    perMonth.set(m, (perMonth.get(m) ?? 0) + amount);
    if (countsUncategorized && categoryId === UNCATEGORIZED_ID && currentMonthSet.has(m)) {
      uncategorizedCount += 1;
    }
  };

  for (const t of transactions) {
    const m = monthOf(t.date);
    const bucket = monthTotals.get(m);
    if (!bucket) continue;
    if (isIncome(t)) bucket.income += netIncomeAmount(t);
    if (isExpense(t)) addExpense(m, t.category, netExpenseAmount(t), true);
  }
  // one uncategorized spread payment is one transaction to categorize, not
  // one per month it covers
  const countedSpreadIds = new Set<string>();
  for (const share of spreadShares) {
    const firstInCurrentRange =
      currentMonthSet.has(share.month) && !countedSpreadIds.has(share.transactionId);
    if (firstInCurrentRange) countedSpreadIds.add(share.transactionId);
    addExpense(
      share.month,
      share.categoryId ? { id: share.categoryId, name: share.categoryName ?? '' } : null,
      Number(share.amount),
      firstInCurrentRange,
    );
  }

  const months: TrendsMonth[] = currentMonths.map((m) => ({
    month: m,
    label: MONTH_LABEL.format(monthStart(m)),
    income: monthTotals.get(m)!.income,
    expense: monthTotals.get(m)!.expense,
  }));

  // Top categories by total spend across the current range determine the
  // stacked-bar's fixed color slots; everything past the cap folds to
  // "Other" so the legend never grows past MAX_CATEGORY_SLOTS + 1. Truly
  // uncategorized spend (no category at all) is tracked separately — it's
  // not a spending pattern to rank against real categories, so it never
  // competes for a color slot and always renders in the same fixed grey,
  // last in the stack, regardless of how large it is.
  const uncategorizedTotal = currentMonths.reduce(
    (sum, m) => sum + (categoryMonthTotals.get(UNCATEGORIZED_ID)?.get(m) ?? 0),
    0,
  );
  const categoryCurrentTotals = Array.from(categoryMonthTotals.entries())
    .filter(([categoryId]) => categoryId !== UNCATEGORIZED_ID)
    .map(([categoryId, perMonth]) => ({
      categoryId,
      total: currentMonths.reduce((sum, m) => sum + (perMonth.get(m) ?? 0), 0),
    }));
  const rankedCategories = categoryCurrentTotals
    .filter((c) => c.total > 0)
    .sort((a, b) => b.total - a.total);
  const topCategoryIds = rankedCategories.slice(0, MAX_CATEGORY_SLOTS).map((c) => c.categoryId);
  const hasOther = rankedCategories.length > MAX_CATEGORY_SLOTS;

  const categories: TrendsCategory[] = topCategoryIds.map((categoryId, i) => ({
    categoryId,
    categoryName: categoryNames.get(categoryId) ?? 'Uncategorized',
    color: CHART_COLORS[i],
  }));
  if (hasOther) {
    categories.push({
      categoryId: OTHER_CATEGORY_ID,
      categoryName: 'Other',
      color: 'var(--ink-muted)',
    });
  }
  if (uncategorizedTotal > 0) {
    categories.push({
      categoryId: UNCATEGORIZED_ID,
      categoryName: 'Uncategorized',
      color: 'var(--ink-muted)',
    });
  }

  const categoryBreakdown: TrendsCategoryMonth[] = currentMonths.map((m) => {
    const segments = topCategoryIds.map((categoryId) => ({
      categoryId,
      amount: categoryMonthTotals.get(categoryId)?.get(m) ?? 0,
    }));
    if (hasOther) {
      const otherAmount = rankedCategories
        .slice(MAX_CATEGORY_SLOTS)
        .reduce((sum, c) => sum + (categoryMonthTotals.get(c.categoryId)?.get(m) ?? 0), 0);
      segments.push({ categoryId: OTHER_CATEGORY_ID, amount: otherAmount });
    }
    if (uncategorizedTotal > 0) {
      segments.push({
        categoryId: UNCATEGORIZED_ID,
        amount: categoryMonthTotals.get(UNCATEGORIZED_ID)?.get(m) ?? 0,
      });
    }
    return { month: m, segments };
  });

  const currentTotal = currentMonths.reduce((sum, m) => sum + monthTotals.get(m)!.expense, 0);
  const priorTotal = priorMonths.reduce((sum, m) => sum + monthTotals.get(m)!.expense, 0);
  const headlinePctChange =
    priorTotal > 0 ? ((currentTotal - priorTotal) / priorTotal) * 100 : null;

  const headline = {
    currentTotal: currentTotal.toFixed(2),
    priorTotal: priorTotal.toFixed(2),
    pctChange: headlinePctChange,
    currentRangeLabel: `${MONTH_LABEL.format(monthStart(currentMonths[0]))}–${MONTH_LABEL.format(monthStart(currentMonths[currentMonths.length - 1]))}`,
    priorRangeLabel: `${MONTH_LABEL.format(monthStart(priorMonths[0]))}–${MONTH_LABEL.format(monthStart(priorMonths[priorMonths.length - 1]))}`,
    tone: (headlinePctChange === null ? 'neutral' : headlinePctChange > 0 ? 'rose' : 'sky') as
      'rose' | 'sky' | 'neutral',
  };

  // Movers: every category that had spend in either period, ranked by the
  // size of its absolute dollar swing — independent of the stacked bar's
  // top-N cap, since a mover worth flagging can sit outside it.
  // Uncategorized isn't a spending pattern, so it's excluded from movers too.
  const allCategoryIds = new Set(
    [...categoryMonthTotals.keys()].filter((id) => id !== UNCATEGORIZED_ID),
  );
  const movers: TrendsMover[] = Array.from(allCategoryIds)
    .map((categoryId) => {
      const perMonth = categoryMonthTotals.get(categoryId)!;
      const current = currentMonths.reduce((sum, m) => sum + (perMonth.get(m) ?? 0), 0);
      const prior = priorMonths.reduce((sum, m) => sum + (perMonth.get(m) ?? 0), 0);
      const amount = current - prior;
      return {
        categoryId,
        categoryName: categoryNames.get(categoryId) ?? 'Uncategorized',
        current,
        prior,
        amount,
        pctChange: prior > 0 ? (amount / prior) * 100 : null,
        tone: (amount >= 0 ? 'rose' : 'sky') as 'rose' | 'sky',
      };
    })
    .filter((m) => m.amount !== 0)
    .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount))
    .slice(0, 5);

  return { range, months, categories, categoryBreakdown, headline, movers, uncategorizedCount };
};
