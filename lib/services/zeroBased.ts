import { computeZbbMonth, targetTopUps, type ZbbCell } from '@/lib/budgets/zero-based-math';
import { monthOfDate, monthRange, shiftMonth } from '@/lib/date';
import { prisma } from '@/lib/db/prisma';
import { currentMonthNumber } from '@/lib/format';
import { getEffectiveLimits, listBudgets, type FrontendBudget } from '@/lib/services/budgets';
import { ServiceValidationError } from '@/lib/services/common';
import {
  fromCents,
  listReimbursedAmountsByExpenseDate,
  toCents,
} from '@/lib/services/reimbursements';
import type {
  BudgetModeInput,
  MoveMoneyInput,
  SetAssignmentInput,
} from '@/lib/validators/zero-based';

export type BudgetMode = 'LIMITS' | 'ZERO_BASED';

export type FrontendBudgetSettings = {
  mode: BudgetMode;
  zbbStartMonth: number | null;
};

export type FrontendZbbCategory = {
  categoryId: string;
  categoryName: string;
  /** available(c, month - 1) */
  carriedIn: string;
  assigned: string;
  activity: string;
  available: string;
  /** effective spending limit for this month, reused as the top-up target */
  target: string | null;
  /** the Budget row behind `target` and the month it was set in, so the
   * screen can patch it in place or fork a new value from this month */
  targetBudgetId: string | null;
  targetMonth: number | null;
};

export type FrontendZbbMonth = {
  month: number;
  startMonth: number;
  /** global, not per month: on-budget balances minus everything committed */
  readyToAssign: string;
  uncategorizedOnBudget: { count: number; total: string };
  categories: FrontendZbbCategory[];
};

/** how far ahead money can be assigned — enough to live a month or more ahead
 * without letting a typo'd year park money a decade out */
const MAX_MONTHS_AHEAD = 12;

// far end of every "from the start month onward" range; transactions can be
// future-dated, so the current month isn't a safe upper bound
const OPEN_END = monthRange(299912).end;

export const getBudgetSettings = async (userId: string): Promise<FrontendBudgetSettings> => {
  const row = await prisma.userBudgetSettings.findUnique({ where: { userId } });
  return { mode: row?.mode ?? 'LIMITS', zbbStartMonth: row?.zbbStartMonth ?? null };
};

/**
 * Switches the user's budgeting mode. Enabling zero-based for the first time
 * pins the start month to the current month; switching back to LIMITS keeps
 * it, so re-enabling resumes with every assignment intact.
 */
export const setBudgetMode = async (
  userId: string,
  input: BudgetModeInput,
): Promise<FrontendBudgetSettings> => {
  const existing = await prisma.userBudgetSettings.findUnique({ where: { userId } });
  const zbbStartMonth =
    existing?.zbbStartMonth ?? (input.mode === 'ZERO_BASED' ? currentMonthNumber() : null);
  const row = await prisma.userBudgetSettings.upsert({
    where: { userId },
    create: { userId, mode: input.mode, zbbStartMonth },
    update: { mode: input.mode, zbbStartMonth },
  });
  return { mode: row.mode, zbbStartMonth: row.zbbStartMonth };
};

const requireZeroBased = async (userId: string): Promise<number> => {
  const settings = await getBudgetSettings(userId);
  if (settings.mode !== 'ZERO_BASED' || settings.zbbStartMonth === null) {
    throw new ServiceValidationError('Zero-based budgeting is not enabled');
  }
  return settings.zbbStartMonth;
};

const assertWritableMonth = (month: number, startMonth: number): void => {
  if (month < startMonth) {
    throw new ServiceValidationError('That month is before zero-based budgeting started');
  }
  if (month > shiftMonth(currentMonthNumber(), MAX_MONTHS_AHEAD)) {
    throw new ServiceValidationError(
      `Money can be assigned at most ${MAX_MONTHS_AHEAD} months ahead`,
    );
  }
};

const assertOwnCategories = async (userId: string, categoryIds: string[]): Promise<void> => {
  const count = await prisma.category.count({ where: { userId, id: { in: categoryIds } } });
  if (count !== new Set(categoryIds).size) {
    throw new ServiceValidationError('Category not found');
  }
};

/** on-budget balance (starting balances plus signed transactions, all time) */
const onBudgetBalanceCents = async (userId: string, accountIds: string[]): Promise<number> => {
  if (accountIds.length === 0) return 0;
  const [accounts, sums] = await Promise.all([
    prisma.account.findMany({
      where: { userId, id: { in: accountIds } },
      select: { startingBalance: true },
    }),
    prisma.transaction.groupBy({
      by: ['type'],
      where: { userId, accountId: { in: accountIds } },
      _sum: { amount: true },
    }),
  ]);
  const starting = accounts.reduce((sum, a) => sum + toCents(a.startingBalance), 0);
  return sums.reduce((sum, row) => {
    const cents = toCents(row._sum.amount ?? 0);
    return sum + (row.type === 'INCOME' ? cents : -cents);
  }, starting);
};

/**
 * Category activity from the start month on: categorized EXPENSEs on on-budget
 * accounts, net of reimbursements (attributed to the expense's month, as in
 * `listBudgets`). A transfer leg counts only when its counterpart sits on an
 * off-budget account — money leaving the budget for savings is spending from
 * the budget's point of view; a card payment between two on-budget accounts
 * isn't.
 */
const categoryActivity = async (
  userId: string,
  accountIds: string[],
  startMonth: number,
): Promise<ZbbCell[]> => {
  if (accountIds.length === 0) return [];
  const start = monthRange(startMonth).start;
  const expenses = await prisma.transaction.findMany({
    where: {
      userId,
      accountId: { in: accountIds },
      type: 'EXPENSE',
      categoryId: { not: null },
      date: { gte: start },
    },
    select: {
      id: true,
      categoryId: true,
      amount: true,
      date: true,
      isTransfer: true,
      transferMatchId: true,
    },
  });

  const matchIds = [
    ...new Set(
      expenses.flatMap((t) => (t.isTransfer && t.transferMatchId ? [t.transferMatchId] : [])),
    ),
  ];
  const [leavingBudget, reimbursed] = await Promise.all([
    matchIds.length > 0
      ? prisma.transaction.findMany({
          where: { userId, transferMatchId: { in: matchIds }, accountId: { notIn: accountIds } },
          select: { transferMatchId: true },
        })
      : Promise.resolve([]),
    listReimbursedAmountsByExpenseDate(userId, start, OPEN_END),
  ]);
  const leavingIds = new Set(leavingBudget.map((t) => t.transferMatchId));

  const cells: ZbbCell[] = [];
  const onBudgetExpenseIds = new Set<string>();
  for (const t of expenses) {
    if (t.isTransfer && !(t.transferMatchId && leavingIds.has(t.transferMatchId))) continue;
    if (!t.isTransfer) onBudgetExpenseIds.add(t.id);
    cells.push({
      categoryId: t.categoryId as string,
      month: monthOfDate(t.date),
      cents: toCents(t.amount),
    });
  }
  for (const r of reimbursed) {
    if (!r.categoryId || !onBudgetExpenseIds.has(r.expenseTransactionId)) continue;
    cells.push({
      categoryId: r.categoryId,
      month: monthOfDate(new Date(r.expenseDate)),
      cents: -toCents(r.amount),
    });
  }
  return cells;
};

const uncategorizedSummary = async (
  userId: string,
  accountIds: string[],
  startMonth: number,
): Promise<{ count: number; total: string }> => {
  if (accountIds.length === 0) return { count: 0, total: '0.00' };
  const result = await prisma.transaction.aggregate({
    where: {
      userId,
      accountId: { in: accountIds },
      type: 'EXPENSE',
      isTransfer: false,
      categoryId: null,
      date: { gte: monthRange(startMonth).start },
    },
    _count: { _all: true },
    _sum: { amount: true },
  });
  return { count: result._count._all, total: fromCents(toCents(result._sum.amount ?? 0)) };
};

/**
 * The zero-based view of one month: Ready to Assign plus carried-in, assigned,
 * activity and available per category. Months before the start month come
 * back with empty numbers; the page shows them as not started.
 */
export const getZbbMonth = async (userId: string, month: number): Promise<FrontendZbbMonth> => {
  const startMonth = await requireZeroBased(userId);
  const accounts = await prisma.account.findMany({
    where: { userId, onBudget: true },
    select: { id: true },
  });
  const accountIds = accounts.map((a) => a.id);

  const [categories, assignmentRows, activity, balanceCents, uncategorized, limits] =
    await Promise.all([
      prisma.category.findMany({
        where: { userId },
        select: { id: true, name: true },
        orderBy: { name: 'asc' },
      }),
      prisma.categoryAssignment.findMany({
        where: { userId, month: { gte: startMonth } },
        select: { categoryId: true, month: true, amount: true },
      }),
      categoryActivity(userId, accountIds, startMonth),
      onBudgetBalanceCents(userId, accountIds),
      uncategorizedSummary(userId, accountIds, startMonth),
      getEffectiveLimits(userId, month),
    ]);

  const result = computeZbbMonth({
    month,
    categoryIds: categories.map((c) => c.id),
    assignments: assignmentRows.map((a) => ({
      categoryId: a.categoryId,
      month: a.month,
      cents: toCents(a.amount),
    })),
    activity,
    onBudgetBalanceCents: balanceCents,
  });
  const nameById = new Map(categories.map((c) => [c.id, c.name]));

  return {
    month,
    startMonth,
    readyToAssign: fromCents(result.readyToAssignCents),
    uncategorizedOnBudget: uncategorized,
    categories: result.categories.map((c) => {
      const limit = limits.get(c.categoryId);
      return {
        categoryId: c.categoryId,
        categoryName: nameById.get(c.categoryId) ?? '',
        carriedIn: fromCents(c.carriedInCents),
        assigned: fromCents(c.assignedCents),
        activity: fromCents(c.activityCents),
        available: fromCents(c.availableCents),
        target: limit ? limit.limitAmount.toFixed(2) : null,
        targetBudgetId: limit?.budgetId ?? null,
        targetMonth: limit?.month ?? null,
      };
    }),
  };
};

type AssignmentClient = Pick<typeof prisma, 'categoryAssignment'>;

/** write one cell's absolute amount; zero removes the row so empty cells stay empty */
const writeCell = async (
  db: AssignmentClient,
  userId: string,
  categoryId: string,
  month: number,
  cents: number,
): Promise<void> => {
  const where = { userId_categoryId_month: { userId, categoryId, month } };
  if (cents === 0) {
    await db.categoryAssignment.deleteMany({ where: { userId, categoryId, month } });
    return;
  }
  const amount = fromCents(cents);
  await db.categoryAssignment.upsert({
    where,
    create: { userId, categoryId, month, amount },
    update: { amount },
  });
};

const cellCents = async (
  db: AssignmentClient,
  userId: string,
  categoryId: string,
  month: number,
): Promise<number> => {
  const row = await db.categoryAssignment.findUnique({
    where: { userId_categoryId_month: { userId, categoryId, month } },
    select: { amount: true },
  });
  return row ? toCents(row.amount) : 0;
};

/**
 * Sets how much is assigned to a category for a month (absolute, not a
 * delta). Ready to Assign may go negative; the page shows that as an error
 * the user fixes by un-assigning, rather than refusing the edit.
 */
export const setAssignment = async (
  userId: string,
  input: SetAssignmentInput,
): Promise<FrontendZbbMonth> => {
  const startMonth = await requireZeroBased(userId);
  assertWritableMonth(input.month, startMonth);
  await assertOwnCategories(userId, [input.categoryId]);
  await writeCell(prisma, userId, input.categoryId, input.month, toCents(input.amount));
  return getZbbMonth(userId, input.month);
};

/** moves money between two categories within one month, atomically */
export const moveMoney = async (
  userId: string,
  input: MoveMoneyInput,
): Promise<FrontendZbbMonth> => {
  const startMonth = await requireZeroBased(userId);
  assertWritableMonth(input.month, startMonth);
  await assertOwnCategories(userId, [input.fromCategoryId, input.toCategoryId]);
  const cents = toCents(input.amount);
  await prisma.$transaction(async (tx) => {
    const [from, to] = await Promise.all([
      cellCents(tx, userId, input.fromCategoryId, input.month),
      cellCents(tx, userId, input.toCategoryId, input.month),
    ]);
    await writeCell(tx, userId, input.fromCategoryId, input.month, from - cents);
    await writeCell(tx, userId, input.toCategoryId, input.month, to + cents);
  });
  return getZbbMonth(userId, input.month);
};

/**
 * Tops every category with a spending limit up to that limit for the month.
 * All or nothing: if Ready to Assign can't cover the total, nothing is written
 * and the error names the shortfall.
 */
export const assignToTargets = async (userId: string, month: number): Promise<FrontendZbbMonth> => {
  const startMonth = await requireZeroBased(userId);
  assertWritableMonth(month, startMonth);
  const current = await getZbbMonth(userId, month);
  const topUps = targetTopUps(
    current.categories.map((c) => ({
      categoryId: c.categoryId,
      carriedInCents: toCents(c.carriedIn),
      assignedCents: toCents(c.assigned),
    })),
    new Map(
      current.categories.flatMap((c) =>
        c.target === null ? [] : [[c.categoryId, toCents(c.target)] as const],
      ),
    ),
  );
  if (topUps.length === 0) {
    return current;
  }
  const totalCents = topUps.reduce((sum, t) => sum + t.topUpCents, 0);
  const readyCents = toCents(current.readyToAssign);
  if (totalCents > readyCents) {
    throw new ServiceValidationError(
      `Reaching every target needs $${fromCents(totalCents)} but only $${fromCents(Math.max(0, readyCents))} is ready to assign`,
    );
  }
  const assignedById = new Map(current.categories.map((c) => [c.categoryId, toCents(c.assigned)]));
  await prisma.$transaction(async (tx) => {
    for (const t of topUps) {
      const next = (assignedById.get(t.categoryId) ?? 0) + t.topUpCents;
      await writeCell(tx, userId, t.categoryId, month, next);
    }
  });
  return getZbbMonth(userId, month);
};

/**
 * The month's budgets in the shape the limits mode uses, for screens (the
 * dashboard rings) that only need "how much could be spent vs how much was".
 * In zero-based mode the "limit" is what the category had to spend this month
 * (carried in plus assigned) and "spent" is its activity. Categories with
 * nothing to spend are left out, the same way limits mode only lists
 * categories that have a limit.
 */
export const listBudgetsForMode = async (
  userId: string,
  month: number,
): Promise<FrontendBudget[]> => {
  const settings = await getBudgetSettings(userId);
  if (settings.mode !== 'ZERO_BASED') {
    return listBudgets(userId, month);
  }
  const zbb = await getZbbMonth(userId, month);
  return zbb.categories.flatMap((c) => {
    const funded = toCents(c.carriedIn) + toCents(c.assigned);
    if (funded <= 0) return [];
    return [
      {
        id: `zbb-${c.categoryId}-${month}`,
        categoryId: c.categoryId,
        categoryName: c.categoryName,
        month,
        limitAmount: fromCents(funded),
        spent: fromCents(Math.max(0, toCents(c.activity))),
      },
    ];
  });
};
