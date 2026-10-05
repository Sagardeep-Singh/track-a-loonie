import { monthRange } from '@/lib/date';
import { prisma } from '@/lib/db/prisma';
import { ServiceValidationError } from '@/lib/services/common';
import { listReimbursedAmountsByExpenseDate } from '@/lib/services/reimbursements';
import { listSpreadSharesInRange } from '@/lib/services/spreadExpenses';
import type { CreateBudgetInput, UpdateBudgetInput } from '@/lib/validators/budgets';

export type FrontendBudget = {
  id: string;
  categoryId: string;
  categoryName: string;
  month: number;
  limitAmount: string;
  spent: string;
};

export const listBudgets = async (userId: string, month: number): Promise<FrontendBudget[]> => {
  const { start, end } = monthRange(month);

  // Budgets repeat month over month until changed: pull the rows at or before
  // the requested month and keep, per category, only the most recent one —
  // that's the value in effect for this month.
  //
  // Bounded at 12 months back (`month - 100` is the same month a year
  // earlier on a YYYYMM int) so the common case can't grow into an unbounded
  // scan of every budget a user has ever set. A category whose newest budget
  // predates that window falls out of the bounded query, so if it comes back
  // empty (a returning user who hasn't touched budgets in over a year) we
  // fall back to the unbounded query rather than silently rendering "no
  // budgets" — this makes the common case bounded without making the result
  // ever lossy.
  const budgetRows = async () => {
    const bounded = await prisma.budget.findMany({
      where: { userId, month: { gte: month - 100, lte: month } },
      include: { category: { select: { name: true } } },
      orderBy: [{ categoryId: 'asc' }, { month: 'desc' }],
    });
    if (bounded.length > 0) {
      return bounded;
    }
    return prisma.budget.findMany({
      where: { userId, month: { lte: month } },
      include: { category: { select: { name: true } } },
      orderBy: [{ categoryId: 'asc' }, { month: 'desc' }],
    });
  };

  const [rows, spentByCategory, reimbursedExpenses, spreadShares] = await Promise.all([
    budgetRows(),
    prisma.transaction.groupBy({
      by: ['categoryId'],
      // a transfer between the user's own accounts isn't spending, even when
      // it carries a category — keep it out of budget spend so this agrees
      // with the dashboard's expense total
      where: {
        userId,
        type: 'EXPENSE',
        isTransfer: false,
        // a spread expense counts through its monthly shares below, not its
        // own date
        spreadMonths: null,
        date: { gte: start, lt: end },
        categoryId: { not: null },
      },
      _sum: { amount: true },
    }),
    // net reimbursements out of spend, attributed to the *expense's* month —
    // a reimbursement received later still reduces the month the money was spent in
    listReimbursedAmountsByExpenseDate(userId, start, end),
    listSpreadSharesInRange(userId, month, month),
  ]);

  const effectiveByCategory = new Map<string, (typeof rows)[number]>();
  for (const row of rows) {
    if (!effectiveByCategory.has(row.categoryId)) {
      effectiveByCategory.set(row.categoryId, row);
    }
  }

  const spentMap = new Map(
    spentByCategory.map((row) => [row.categoryId as string, Number(row._sum.amount ?? 0)]),
  );

  for (const share of spreadShares) {
    if (!share.categoryId) continue;
    spentMap.set(share.categoryId, (spentMap.get(share.categoryId) ?? 0) + Number(share.amount));
  }

  const reimbursedByCategory = new Map<string, number>();
  for (const r of reimbursedExpenses) {
    if (!r.categoryId) continue;
    reimbursedByCategory.set(
      r.categoryId,
      (reimbursedByCategory.get(r.categoryId) ?? 0) + Number(r.amount),
    );
  }

  return [...effectiveByCategory.values()]
    .sort((a, b) => a.category.name.localeCompare(b.category.name))
    .map((budget) => {
      const grossSpent = spentMap.get(budget.categoryId) ?? 0;
      const reimbursed = reimbursedByCategory.get(budget.categoryId) ?? 0;
      return {
        id: budget.id,
        categoryId: budget.categoryId,
        categoryName: budget.category.name,
        month: budget.month,
        limitAmount: Number(budget.limitAmount).toFixed(2),
        spent: Math.max(0, grossSpent - reimbursed).toFixed(2),
      };
    });
};

export const createBudget = async (
  userId: string,
  input: CreateBudgetInput,
): Promise<FrontendBudget> => {
  const category = await prisma.category.findFirst({ where: { id: input.categoryId, userId } });
  if (!category) {
    throw new ServiceValidationError('Category not found');
  }

  const existing = await prisma.budget.findFirst({
    where: { userId, categoryId: input.categoryId, month: input.month },
  });
  if (existing) {
    throw new ServiceValidationError('A budget for this category and month already exists');
  }

  const budget = await prisma.budget.create({
    data: {
      userId,
      categoryId: input.categoryId,
      month: input.month,
      limitAmount: input.limitAmount,
    },
  });

  return {
    id: budget.id,
    categoryId: budget.categoryId,
    categoryName: category.name,
    month: budget.month,
    limitAmount: Number(budget.limitAmount).toFixed(2),
    spent: '0.00',
  };
};

export const updateBudget = async (
  userId: string,
  budgetId: string,
  input: UpdateBudgetInput,
): Promise<void> => {
  const existing = await prisma.budget.findFirst({ where: { id: budgetId, userId } });
  if (!existing) {
    throw new ServiceValidationError('Budget not found');
  }
  await prisma.budget.update({ where: { id: budgetId }, data: { limitAmount: input.limitAmount } });
};

export const deleteBudget = async (userId: string, budgetId: string): Promise<void> => {
  const existing = await prisma.budget.findFirst({ where: { id: budgetId, userId } });
  if (!existing) {
    throw new ServiceValidationError('Budget not found');
  }
  await prisma.budget.delete({ where: { id: budgetId } });
};

/**
 * Effective spending limit per category for `month` (the newest row at or
 * before it, same carry-forward rule as `listBudgets`). Zero-based mode reuses
 * these limits as targets, so it needs the values without the spend
 * aggregation `listBudgets` does, plus the row id and origin month so a
 * target edit can patch in place or fork a new month like the limits screen.
 */
export const getEffectiveLimits = async (
  userId: string,
  month: number,
): Promise<Map<string, { budgetId: string; month: number; limitAmount: number }>> => {
  const rows = await prisma.budget.findMany({
    where: { userId, month: { lte: month } },
    select: { id: true, categoryId: true, month: true, limitAmount: true },
    orderBy: [{ categoryId: 'asc' }, { month: 'desc' }],
  });
  const limits = new Map<string, { budgetId: string; month: number; limitAmount: number }>();
  for (const row of rows) {
    if (!limits.has(row.categoryId)) {
      limits.set(row.categoryId, {
        budgetId: row.id,
        month: row.month,
        limitAmount: Number(row.limitAmount),
      });
    }
  }
  return limits;
};
