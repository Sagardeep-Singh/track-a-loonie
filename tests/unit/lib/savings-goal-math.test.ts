import { describe, expect, it } from 'vitest';
import {
  computeGoalMonth,
  coverageBySpend,
  plannedBeforeCents,
  type GoalDefinition,
} from '@/lib/budgets/savings-goal-math';

// the plan's worked example: $3,000 by Aug 2027, created Oct 2026 (11 months)
const trip: GoalDefinition = {
  targetCents: 300000,
  startingCents: 0,
  startMonth: 202610,
  targetMonth: 202708,
};

const contributions = (entries: [number, number][]): Map<number, number> => new Map(entries);

describe('computeGoalMonth', () => {
  it('splits the target evenly in the first month, extra cents first', () => {
    const result = computeGoalMonth(trip, new Map(), 202610);
    expect(result.needCents).toBe(27273);
    expect(result.monthsLeft).toBe(11);
    expect(result.schedule).toHaveLength(11);
    expect(result.schedule.reduce((sum, s) => sum + s.cents, 0)).toBe(300000);
    expect(result.schedule.at(-1)).toEqual({ month: 202708, cents: 27272 });
    expect(result.status).toBe('ON_TRACK');
  });

  it("doesn't shrink this month's need as the user contributes", () => {
    const result = computeGoalMonth(trip, contributions([[202610, 27273]]), 202610);
    expect(result.needCents).toBe(27273);
    expect(result.contributedCents).toBe(27273);
    expect(result.savedCents).toBe(27273);
  });

  it('raises the need and reports behind after a missed month', () => {
    const history = contributions([[202610, 27273]]);
    const dec = computeGoalMonth(trip, history, 202612);
    expect(dec.needCents).toBe(30303);
    expect(dec.status).toBe('BEHIND');
  });

  it('stays behind until the total catches up with the plan', () => {
    const history = contributions([
      [202610, 27273],
      [202612, 50000],
    ]);
    const jan = computeGoalMonth(trip, history, 202701);
    expect(jan.progressBeforeCents).toBe(77273);
    expect(jan.needCents).toBe(27841);
    expect(jan.status).toBe('BEHIND');

    // paying only the raised need keeps closing the gap but doesn't close it
    const paidNeed = computeGoalMonth(trip, contributions([...history, [202701, 27841]]), 202702);
    expect(paidNeed.status).toBe('BEHIND');

    // $818.19 planned for Oct to Dec plus $272.73 for Jan
    const caughtUp = computeGoalMonth(trip, contributions([...history, [202701, 31819]]), 202702);
    expect(caughtUp.status).toBe('ON_TRACK');
  });

  it('lowers later months when ahead and stays on track', () => {
    const history = contributions([
      [202610, 27273],
      [202611, 27273],
      [202612, 50000],
    ]);
    const jan = computeGoalMonth(trip, history, 202701);
    expect(jan.needCents).toBe(24432);
    expect(jan.status).toBe('ON_TRACK');
  });

  it('withdrawals lower progress and raise later months', () => {
    const result = computeGoalMonth(
      trip,
      contributions([
        [202610, 27273],
        [202611, -10000],
      ]),
      202612,
    );
    expect(result.progressBeforeCents).toBe(17273);
    expect(result.needCents).toBe(Math.ceil((300000 - 17273) / 9));
  });

  it('counts the starting amount and ignores contributions before the start month', () => {
    const goal = { ...trip, startingCents: 100000 };
    const result = computeGoalMonth(goal, contributions([[202609, 99999]]), 202610);
    expect(result.progressBeforeCents).toBe(100000);
    expect(result.needCents).toBe(18182);
    expect(result.status).toBe('ON_TRACK');
  });

  it('is funded once saved reaches the target, with nothing more needed', () => {
    const result = computeGoalMonth(trip, contributions([[202610, 300000]]), 202611);
    expect(result.status).toBe('FUNDED');
    expect(result.needCents).toBe(0);
    expect(result.schedule).toEqual([]);
  });

  it('asks for the whole remainder in the target month', () => {
    const result = computeGoalMonth(trip, contributions([[202610, 250000]]), 202708);
    expect(result.monthsLeft).toBe(1);
    expect(result.needCents).toBe(50000);
  });

  it('is overdue past the target month with the whole remainder due', () => {
    const result = computeGoalMonth(trip, contributions([[202610, 250000]]), 202710);
    expect(result.status).toBe('OVERDUE');
    expect(result.monthsLeft).toBe(0);
    expect(result.needCents).toBe(50000);
    expect(result.schedule).toEqual([{ month: 202710, cents: 50000 }]);
  });

  it('has nothing needed before the goal starts', () => {
    const result = computeGoalMonth(trip, new Map(), 202609);
    expect(result.status).toBe('NOT_STARTED');
    expect(result.needCents).toBe(0);
    expect(result.contributedCents).toBe(0);
  });
});

describe('plannedBeforeCents', () => {
  it('sums the original split for elapsed months only', () => {
    expect(plannedBeforeCents(trip, 202610)).toBe(0);
    expect(plannedBeforeCents(trip, 202612)).toBe(54546);
    expect(plannedBeforeCents(trip, 202701)).toBe(81819);
    expect(plannedBeforeCents(trip, 203001)).toBe(300000);
  });
});

describe('coverageBySpend', () => {
  it('covers spending up to what has been saved', () => {
    const covered = coverageBySpend(trip, contributions([[202610, 300000]]), [
      { id: 'flights', month: 202708, cents: 140000 },
      { id: 'hotel', month: 202708, cents: 120000 },
    ]);
    expect(covered.get('flights')).toBe(140000);
    expect(covered.get('hotel')).toBe(120000);
  });

  it('leaves spending past the saved balance uncovered', () => {
    const covered = coverageBySpend(trip, contributions([[202610, 300000]]), [
      { id: 'flights', month: 202708, cents: 200000 },
      { id: 'hotel', month: 202708, cents: 130000 },
    ]);
    expect(covered.get('flights')).toBe(200000);
    expect(covered.get('hotel')).toBe(100000);
  });

  it("counts a month's contribution before that month's spending", () => {
    const covered = coverageBySpend(trip, contributions([[202611, 5000]]), [
      { id: 'deposit', month: 202611, cents: 8000 },
    ]);
    expect(covered.get('deposit')).toBe(5000);
  });

  it('carries the drawn-down balance into later months', () => {
    const covered = coverageBySpend(
      trip,
      contributions([
        [202610, 10000],
        [202611, 10000],
      ]),
      [
        { id: 'a', month: 202610, cents: 8000 },
        { id: 'b', month: 202611, cents: 15000 },
      ],
    );
    expect(covered.get('a')).toBe(8000);
    expect(covered.get('b')).toBe(12000);
  });

  it('uses the starting amount and ignores spending before the start month', () => {
    const covered = coverageBySpend({ ...trip, startingCents: 5000 }, new Map(), [
      { id: 'early', month: 202609, cents: 5000 },
      { id: 'later', month: 202611, cents: 7000 },
    ]);
    expect(covered.has('early')).toBe(false);
    expect(covered.get('later')).toBe(5000);
  });

  it('covers nothing when withdrawals leave the balance negative', () => {
    const covered = coverageBySpend(trip, contributions([[202610, -5000]]), [
      { id: 'a', month: 202611, cents: 1000 },
    ]);
    expect(covered.size).toBe(0);
  });
});
