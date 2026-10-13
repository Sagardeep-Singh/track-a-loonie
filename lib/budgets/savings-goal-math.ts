import { monthsBetween } from '@/lib/date';
import { allocateSpread, type SpreadShare } from '@/lib/spread';

/**
 * Pure savings goal math, kept apart from Prisma (like `zero-based-math.ts`)
 * so it can be tested on plain numbers. Everything is integer cents and
 * YYYYMM months.
 *
 * The monthly need is never stored: it's whatever is still missing at the
 * start of the month, split evenly over the months left, so falling behind
 * raises later months and getting ahead lowers them. Rounding follows
 * `allocateSpread`: extra cents go to the earliest months.
 */

export type GoalStatus = 'NOT_STARTED' | 'FUNDED' | 'OVERDUE' | 'BEHIND' | 'ON_TRACK';

export type GoalDefinition = {
  targetCents: number;
  startingCents: number;
  /** YYYYMM month the goal was created; contributions count from here */
  startMonth: number;
  /** YYYYMM month the target should be reached by, inclusive */
  targetMonth: number;
};

export type GoalMonthResult = {
  /** starting amount plus contributions before `month` */
  progressBeforeCents: number;
  contributedCents: number;
  /** progress before plus this month's contribution */
  savedCents: number;
  needCents: number;
  /** 1 in the target month, 0 once it has passed */
  monthsLeft: number;
  status: GoalStatus;
  /** planned amounts from `month` to the target month for what's still missing */
  schedule: SpreadShare[];
};

/** sum of the original even split for the months before `month` */
export const plannedBeforeCents = (goal: GoalDefinition, month: number): number => {
  const totalMonths = monthsBetween(goal.startMonth, goal.targetMonth) + 1;
  const elapsed = Math.min(Math.max(monthsBetween(goal.startMonth, month), 0), totalMonths);
  if (elapsed === 0) return 0;
  const plan = allocateSpread(Math.max(0, goal.targetCents - goal.startingCents), goal.startMonth, totalMonths);
  return plan.slice(0, elapsed).reduce((sum, share) => sum + share.cents, 0);
};

/**
 * One goal in one month. `contributionsByMonth` holds the goal's net
 * contribution per month; months before the goal's start month are ignored.
 */
export const computeGoalMonth = (
  goal: GoalDefinition,
  contributionsByMonth: Map<number, number>,
  month: number,
): GoalMonthResult => {
  let progressBeforeCents = goal.startingCents;
  for (const [m, cents] of contributionsByMonth) {
    if (m >= goal.startMonth && m < month) progressBeforeCents += cents;
  }
  const contributedCents = month >= goal.startMonth ? (contributionsByMonth.get(month) ?? 0) : 0;
  const savedCents = progressBeforeCents + contributedCents;
  const remainingCents = Math.max(0, goal.targetCents - progressBeforeCents);
  const monthsLeft = Math.max(0, monthsBetween(month, goal.targetMonth) + 1);

  const notStarted = month < goal.startMonth;
  const schedule =
    notStarted || remainingCents === 0
      ? []
      : monthsLeft === 0
        ? [{ month, cents: remainingCents }]
        : allocateSpread(remainingCents, month, monthsLeft);
  const needCents = schedule[0]?.cents ?? 0;

  const status: GoalStatus = notStarted
    ? 'NOT_STARTED'
    : savedCents >= goal.targetCents
      ? 'FUNDED'
      : monthsLeft === 0
        ? 'OVERDUE'
        : progressBeforeCents < goal.startingCents + plannedBeforeCents(goal, month)
          ? 'BEHIND'
          : 'ON_TRACK';

  return {
    progressBeforeCents,
    contributedCents,
    savedCents,
    needCents,
    monthsLeft,
    status,
    schedule,
  };
};

export type GoalSpend = { id: string; month: number; cents: number };

/**
 * How much of each spend from a goal the goal covers. Walks month by month
 * from the start month: each month's contribution joins the balance first,
 * then that month's spends (in the order given, which callers keep by date)
 * draw it down. Coverage never exceeds what's been saved; anything past it
 * stays a normal expense.
 */
export const coverageBySpend = (
  goal: Pick<GoalDefinition, 'startingCents' | 'startMonth'>,
  contributionsByMonth: Map<number, number>,
  spends: GoalSpend[],
): Map<string, number> => {
  const months = [
    ...new Set([
      ...[...contributionsByMonth.keys()].filter((m) => m >= goal.startMonth),
      ...spends.filter((s) => s.month >= goal.startMonth).map((s) => s.month),
    ]),
  ].sort((a, b) => a - b);

  const covered = new Map<string, number>();
  let balanceCents = goal.startingCents;
  for (const month of months) {
    balanceCents += contributionsByMonth.get(month) ?? 0;
    for (const spend of spends) {
      if (spend.month !== month) continue;
      const cents = Math.min(spend.cents, Math.max(0, balanceCents));
      if (cents <= 0) continue;
      covered.set(spend.id, cents);
      balanceCents -= cents;
    }
  }
  return covered;
};
