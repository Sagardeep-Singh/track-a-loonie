import { monthRange } from '@/lib/date';
import { prisma } from '@/lib/db/prisma';
import { ServiceValidationError } from '@/lib/services/common';
import { listReimbursedAmounts } from '@/lib/services/reimbursements';
import { categoryHasGoal } from '@/lib/services/savingsGoals';
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
  // that's the value in effect for this month. No lower bound on `month`: a
  // category whose limit was last set years ago is still in effect, and a
  // window here would silently drop it (getEffectiveLimits reads the same way).
  const budgetRows = () =>
    prisma.budget.findMany({
      where: { userId, month: { lte: month } },
      include: { category: { select: { name: true } } },
      orderBy: [{ categoryId: 'asc' }, { month: 'desc' }],
      distinct: ['categoryId'],
    });

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
    // with the expense-month setting, reimbursements net out of the expense's
    // month; by default spend stays in full (see listReimbursedAmounts)
    listReimbursedAmounts(userId, start, end),
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
  // a cap and a savings floor on one category would make both numbers meaningless
  if (await categoryHasGoal(userId, input.categoryId)) {
    throw new ServiceValidationError(
      'This category has a savings goal. Remove the goal before adding a spending limit',
    );
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
