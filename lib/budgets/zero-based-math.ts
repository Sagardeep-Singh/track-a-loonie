/**
 * Pure zero-based budgeting math, kept apart from Prisma so it can be tested
 * on plain numbers. Everything is integer cents to avoid float drift.
 *
 * available(c, m) = available(c, m - 1) + assigned(c, m) - activity(c, m),
 * starting from 0 the month before the start month. Negative balances carry
 * forward, so available is simply cumulative assigned minus cumulative
 * activity up to and including `m`.
 *
 * Ready to Assign = on-budget balances - sum over categories of (all
 * assigned - all activity). It's global, not per month: assigning to a
 * future month reduces it today.
 */

export type ZbbCell = { categoryId: string; month: number; cents: number };

export type ZbbCategoryMonth = {
  categoryId: string;
  carriedInCents: number;
  assignedCents: number;
  activityCents: number;
  availableCents: number;
};

export type ZbbMonthResult = {
  readyToAssignCents: number;
  categories: ZbbCategoryMonth[];
};

export const computeZbbMonth = (args: {
  month: number;
  categoryIds: string[];
  assignments: ZbbCell[];
  activity: ZbbCell[];
  onBudgetBalanceCents: number;
}): ZbbMonthResult => {
  const { month, categoryIds, assignments, activity, onBudgetBalanceCents } = args;

  const blank = (): ZbbCategoryMonth & { totalCents: number } => ({
    categoryId: '',
    carriedInCents: 0,
    assignedCents: 0,
    activityCents: 0,
    availableCents: 0,
    totalCents: 0,
  });
  const byCategory = new Map<string, ReturnType<typeof blank>>();
  const row = (categoryId: string): ReturnType<typeof blank> => {
    let entry = byCategory.get(categoryId);
    if (!entry) {
      entry = { ...blank(), categoryId };
      byCategory.set(categoryId, entry);
    }
    return entry;
  };
  const shown = new Set(categoryIds);
  for (const id of categoryIds) row(id);

  // sign: assignments add to a category, activity takes from it
  const apply = (cell: ZbbCell, sign: 1 | -1, field: 'assignedCents' | 'activityCents'): void => {
    const entry = row(cell.categoryId);
    const delta = sign * cell.cents;
    entry.totalCents += delta;
    if (cell.month < month) {
      entry.carriedInCents += delta;
    } else if (cell.month === month) {
      entry[field] += cell.cents;
    }
  };
  for (const cell of assignments) apply(cell, 1, 'assignedCents');
  for (const cell of activity) apply(cell, -1, 'activityCents');

  let committedCents = 0;
  const categories: ZbbCategoryMonth[] = [];
  for (const entry of byCategory.values()) {
    committedCents += entry.totalCents;
    if (!shown.has(entry.categoryId)) continue;
    categories.push({
      categoryId: entry.categoryId,
      carriedInCents: entry.carriedInCents,
      assignedCents: entry.assignedCents,
      activityCents: entry.activityCents,
      availableCents: entry.carriedInCents + entry.assignedCents - entry.activityCents,
    });
  }

  return { readyToAssignCents: onBudgetBalanceCents - committedCents, categories };
};

/**
 * How much "Assign to targets" adds to each category this month: enough to
 * bring carried-in plus assigned up to the target, never a negative top-up.
 */
export const targetTopUps = (
  categories: Pick<ZbbCategoryMonth, 'categoryId' | 'carriedInCents' | 'assignedCents'>[],
  targetCentsByCategory: Map<string, number>,
): { categoryId: string; topUpCents: number }[] =>
  categories.flatMap((c) => {
    const target = targetCentsByCategory.get(c.categoryId);
    if (target === undefined) return [];
    const topUpCents = target - (c.carriedInCents + c.assignedCents);
    return topUpCents > 0 ? [{ categoryId: c.categoryId, topUpCents }] : [];
  });
