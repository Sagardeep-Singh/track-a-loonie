import type { Prisma } from '@prisma/client';
import {
  computeGoalMonth,
  coverageBySpend,
  type GoalDefinition,
  type GoalSpend,
  type GoalStatus,
} from '@/lib/budgets/savings-goal-math';
import { monthOfDate, monthRange, shiftMonth } from '@/lib/date';
import { prisma } from '@/lib/db/prisma';
import { currentMonthNumber } from '@/lib/format';
import { ServiceValidationError } from '@/lib/services/common';
import { fromCents, toCents } from '@/lib/services/reimbursements';
import type {
  CreateSavingsGoalInput,
  UpdateSavingsGoalInput,
} from '@/lib/validators/savings-goals';

export type FrontendSavingsGoal = {
  id: string;
  categoryId: string;
  categoryName: string;
  targetAmount: string;
  targetMonth: number;
  startMonth: number;
  startingAmount: string;
  /** starting amount plus every contribution up to and including the month */
  saved: string;
  needThisMonth: string;
  contributedThisMonth: string;
  monthsLeft: number;
  status: GoalStatus;
  /** spending from the goal up to and including the month */
  spent: string;
  /** what's left to spend: saved minus the spending the goal covered */
  balance: string;
  /** planned amounts from the month to the target month */
  schedule: { month: number; amount: string }[];
  archivedAt: string | null;
};

/** how far out a target month can be set */
const MAX_YEARS_OUT = 10;

type GoalRow = {
  id: string;
  categoryId: string;
  targetAmount: Prisma.Decimal;
  targetMonth: number;
  startMonth: number;
  startingAmount: Prisma.Decimal;
  archivedAt: Date | null;
  category: { name: string };
};

type GoalActivity = {
  contributions: Map<number, number>;
  spends: GoalSpend[];
};

const definitionOf = (goal: GoalRow): GoalDefinition => ({
  targetCents: toCents(goal.targetAmount),
  startingCents: toCents(goal.startingAmount),
  startMonth: goal.startMonth,
  targetMonth: goal.targetMonth,
});

const isZeroBased = async (userId: string): Promise<boolean> => {
  const settings = await prisma.userBudgetSettings.findUnique({ where: { userId } });
  return settings?.mode === 'ZERO_BASED';
};

const addTo = (map: Map<number, number>, month: number, cents: number): void => {
  map.set(month, (map.get(month) ?? 0) + cents);
};

/**
 * Contributions and spending per goal category, from the earliest goal's start
 * month through `upToMonth`.
 *
 * Contributions follow the budgeting mode. Limits mode: transfer legs in the
 * goal's category on spending (`onBudget`) accounts, EXPENSE in and INCOME out.
 * Only the spending side counts, so a matched pair with both legs categorized
 * isn't cancelled out, and a savings account that isn't imported still works.
 * Zero-based: what was assigned to the category.
 *
 * Spending is every plain non-transfer EXPENSE in the category, on any account.
 * Spread and reimbursable expenses keep counting through their own rules.
 */
const loadGoalActivity = async (
  userId: string,
  goals: GoalRow[],
  upToMonth: number,
): Promise<Map<string, GoalActivity>> => {
  const activity = new Map<string, GoalActivity>(
    goals.map((g) => [g.categoryId, { contributions: new Map(), spends: [] }]),
  );
  if (goals.length === 0) return activity;

  const categoryIds = goals.map((g) => g.categoryId);
  const fromMonth = Math.min(...goals.map((g) => g.startMonth));
  const dateRange = { gte: monthRange(fromMonth).start, lt: monthRange(upToMonth).end };

  const [zeroBased, spends] = await Promise.all([
    isZeroBased(userId),
    prisma.transaction.findMany({
      where: {
        userId,
        categoryId: { in: categoryIds },
        type: 'EXPENSE',
        isTransfer: false,
        isReimbursable: false,
        spreadMonths: null,
        date: dateRange,
      },
      select: { id: true, categoryId: true, amount: true, date: true },
      orderBy: [{ date: 'asc' }, { id: 'asc' }],
    }),
  ]);

  for (const t of spends) {
    activity.get(t.categoryId as string)?.spends.push({
      id: t.id,
      month: monthOfDate(t.date),
      cents: toCents(t.amount),
    });
  }

  if (zeroBased) {
    const assignments = await prisma.categoryAssignment.findMany({
      where: { userId, categoryId: { in: categoryIds }, month: { gte: fromMonth, lte: upToMonth } },
      select: { categoryId: true, month: true, amount: true },
    });
    for (const a of assignments) {
      const entry = activity.get(a.categoryId);
      if (entry) addTo(entry.contributions, a.month, toCents(a.amount));
    }
  } else {
    const transfers = await prisma.transaction.findMany({
      where: {
        userId,
        categoryId: { in: categoryIds },
        isTransfer: true,
        account: { onBudget: true },
        date: dateRange,
      },
      select: { categoryId: true, amount: true, date: true, type: true },
    });
    for (const t of transfers) {
      const entry = activity.get(t.categoryId as string);
      const cents = toCents(t.amount);
      if (entry) addTo(entry.contributions, monthOfDate(t.date), t.type === 'EXPENSE' ? cents : -cents);
    }
  }

  return activity;
};

const goalInclude = { category: { select: { name: true } } } as const;

const toFrontend = (goal: GoalRow, activity: GoalActivity, month: number): FrontendSavingsGoal => {
  const definition = definitionOf(goal);
  const result = computeGoalMonth(definition, activity.contributions, month);
  const spendsSoFar = activity.spends.filter((s) => s.month <= month);
  const covered = coverageBySpend(definition, activity.contributions, spendsSoFar);
  const spentCents = spendsSoFar
    .filter((s) => s.month >= goal.startMonth)
    .reduce((sum, s) => sum + s.cents, 0);
  const coveredCents = [...covered.values()].reduce((sum, c) => sum + c, 0);

  return {
    id: goal.id,
    categoryId: goal.categoryId,
    categoryName: goal.category.name,
    targetAmount: fromCents(definition.targetCents),
    targetMonth: goal.targetMonth,
    startMonth: goal.startMonth,
    startingAmount: fromCents(definition.startingCents),
    saved: fromCents(result.savedCents),
    needThisMonth: fromCents(result.needCents),
    contributedThisMonth: fromCents(result.contributedCents),
    monthsLeft: result.monthsLeft,
    status: result.status,
    spent: fromCents(spentCents),
    balance: fromCents(result.savedCents - coveredCents),
    schedule: result.schedule.map((s) => ({ month: s.month, amount: fromCents(s.cents) })),
    archivedAt: goal.archivedAt ? goal.archivedAt.toISOString() : null,
  };
};

export const listSavingsGoals = async (
  userId: string,
  month: number,
  options: { includeArchived?: boolean } = {},
): Promise<FrontendSavingsGoal[]> => {
  const goals = await prisma.savingsGoal.findMany({
    where: { userId, ...(options.includeArchived ? {} : { archivedAt: null }) },
    include: goalInclude,
  });
  const activity = await loadGoalActivity(userId, goals, month);
  return goals
    .sort((a, b) => a.targetMonth - b.targetMonth || a.category.name.localeCompare(b.category.name))
    .map((g) => toFrontend(g, activity.get(g.categoryId)!, month));
};

const getOwnGoal = async (userId: string, goalId: string): Promise<GoalRow> => {
  const goal = await prisma.savingsGoal.findFirst({
    where: { id: goalId, userId },
    include: goalInclude,
  });
  if (!goal) {
    throw new ServiceValidationError('Savings goal not found');
  }
  return goal;
};

const assertTargetMonth = (targetMonth: number, startMonth: number): void => {
  if (targetMonth < startMonth) {
    throw new ServiceValidationError('The target month must be this month or later');
  }
  if (targetMonth > shiftMonth(startMonth, MAX_YEARS_OUT * 12)) {
    throw new ServiceValidationError(
      `The target month can be at most ${MAX_YEARS_OUT} years after the goal started`,
    );
  }
};

/**
 * Creates a goal on an existing category or on a new one. A category holds one
 * goal and can't also have a spending limit: a cap and a floor on the same
 * category would make both numbers meaningless.
 */
export const createSavingsGoal = async (
  userId: string,
  input: CreateSavingsGoalInput,
): Promise<FrontendSavingsGoal> => {
  const startMonth = currentMonthNumber();
  assertTargetMonth(input.targetMonth, startMonth);

  const goal = await prisma.$transaction(async (tx) => {
    let categoryId = input.categoryId;
    if (input.newCategoryName) {
      const existing = await tx.category.findFirst({
        where: { userId, name: input.newCategoryName },
      });
      if (existing) {
        throw new ServiceValidationError('A category with this name already exists');
      }
      categoryId = (await tx.category.create({ data: { userId, name: input.newCategoryName } })).id;
    } else {
      const category = await tx.category.findFirst({ where: { id: categoryId, userId } });
      if (!category) {
        throw new ServiceValidationError('Category not found');
      }
      const [goalCount, budgetCount] = await Promise.all([
        tx.savingsGoal.count({ where: { categoryId } }),
        tx.budget.count({ where: { userId, categoryId } }),
      ]);
      if (goalCount > 0) {
        throw new ServiceValidationError('This category already has a savings goal');
      }
      if (budgetCount > 0) {
        throw new ServiceValidationError(
          'This category has a spending limit. Remove the limit before adding a savings goal',
        );
      }
    }
    return tx.savingsGoal.create({
      data: {
        userId,
        categoryId: categoryId as string,
        targetAmount: input.targetAmount,
        targetMonth: input.targetMonth,
        startMonth,
        startingAmount: input.startingAmount,
      },
      include: goalInclude,
    });
  });

  const activity = await loadGoalActivity(userId, [goal], startMonth);
  return toFrontend(goal, activity.get(goal.categoryId)!, startMonth);
};

export const updateSavingsGoal = async (
  userId: string,
  goalId: string,
  input: UpdateSavingsGoalInput,
): Promise<void> => {
  const goal = await getOwnGoal(userId, goalId);
  assertTargetMonth(input.targetMonth, goal.startMonth);
  await prisma.savingsGoal.update({
    where: { id: goal.id },
    data: {
      targetAmount: input.targetAmount,
      targetMonth: input.targetMonth,
      startingAmount: input.startingAmount,
    },
  });
};

export const setSavingsGoalArchived = async (
  userId: string,
  goalId: string,
  archived: boolean,
): Promise<void> => {
  const goal = await getOwnGoal(userId, goalId);
  await prisma.savingsGoal.update({
    where: { id: goal.id },
    data: { archivedAt: archived ? (goal.archivedAt ?? new Date()) : null },
  });
};

/** deletes the goal only; the category and its transactions stay */
export const deleteSavingsGoal = async (userId: string, goalId: string): Promise<void> => {
  const goal = await getOwnGoal(userId, goalId);
  await prisma.savingsGoal.delete({ where: { id: goal.id } });
};

export type GoalMonthEffects = {
  goalCategoryIds: Set<string>;
  /** net contributions per month across all goals, cents */
  savedByMonth: Map<number, number>;
  /** cents of each goal-spending transaction the goal covers */
  coveredByTransaction: Map<string, number>;
  /** spending from goals per month that went past what was saved, cents */
  uncoveredByMonth: Map<number, number>;
};

/**
 * What goals change in reporting for months up to `upToMonth`: contributions
 * count as saved in their month, and spending a goal covers isn't counted as
 * an expense again. Archived goals still apply, since the money moved anyway.
 */
export const getGoalEffects = async (
  userId: string,
  upToMonth: number,
): Promise<GoalMonthEffects> => {
  const goals = await prisma.savingsGoal.findMany({ where: { userId }, include: goalInclude });
  const effects: GoalMonthEffects = {
    goalCategoryIds: new Set(goals.map((g) => g.categoryId)),
    savedByMonth: new Map(),
    coveredByTransaction: new Map(),
    uncoveredByMonth: new Map(),
  };
  if (goals.length === 0) return effects;

  const activity = await loadGoalActivity(userId, goals, upToMonth);
  for (const goal of goals) {
    const entry = activity.get(goal.categoryId)!;
    for (const [month, cents] of entry.contributions) {
      if (month >= goal.startMonth) addTo(effects.savedByMonth, month, cents);
    }
    const covered = coverageBySpend(definitionOf(goal), entry.contributions, entry.spends);
    for (const spend of entry.spends) {
      if (spend.month < goal.startMonth) continue;
      const cents = covered.get(spend.id) ?? 0;
      if (cents > 0) effects.coveredByTransaction.set(spend.id, cents);
      if (spend.cents > cents) addTo(effects.uncoveredByMonth, spend.month, spend.cents - cents);
    }
  }
  return effects;
};

export type GoalTarget = {
  goalId: string;
  needCents: number;
  targetAmount: string;
  targetMonth: number;
};

/** this month's need per active goal category, which zero-based mode uses as the target */
export const getGoalTargets = async (
  userId: string,
  month: number,
): Promise<Map<string, GoalTarget>> => {
  const goals = await prisma.savingsGoal.findMany({
    where: { userId, archivedAt: null },
    include: goalInclude,
  });
  const targets = new Map<string, GoalTarget>();
  if (goals.length === 0) return targets;

  const activity = await loadGoalActivity(userId, goals, month);
  for (const goal of goals) {
    const result = computeGoalMonth(
      definitionOf(goal),
      activity.get(goal.categoryId)!.contributions,
      month,
    );
    targets.set(goal.categoryId, {
      goalId: goal.id,
      needCents: result.needCents,
      targetAmount: fromCents(toCents(goal.targetAmount)),
      targetMonth: goal.targetMonth,
    });
  }
  return targets;
};

/** whether the category has a savings goal; a spending limit can't be added to it */
export const categoryHasGoal = async (userId: string, categoryId: string): Promise<boolean> =>
  (await prisma.savingsGoal.count({ where: { userId, categoryId } })) > 0;
