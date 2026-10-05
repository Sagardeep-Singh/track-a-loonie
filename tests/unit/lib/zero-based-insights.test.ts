import { describe, expect, it } from 'vitest';
import {
  buildZbbInsights,
  type ZbbInsightCategory,
  type ZbbInsightInput,
} from '@/lib/budgets/zero-based-insights';

const cat = (
  name: string,
  dollars: { carried?: number; assigned?: number; spent?: number; target?: number },
): ZbbInsightCategory => {
  const carried = Math.round((dollars.carried ?? 0) * 100);
  const assigned = Math.round((dollars.assigned ?? 0) * 100);
  const spent = Math.round((dollars.spent ?? 0) * 100);
  return {
    categoryId: name.toLowerCase(),
    categoryName: name,
    carriedInCents: carried,
    assignedCents: assigned,
    activityCents: spent,
    availableCents: carried + assigned - spent,
    targetCents: dollars.target === undefined ? null : Math.round(dollars.target * 100),
  };
};

const input = (overrides: Partial<ZbbInsightInput>): ZbbInsightInput => ({
  month: 202610,
  today: null,
  readyToAssignCents: 0,
  categories: [],
  uncategorized: { count: 0, cents: 0 },
  nextMonthAssignedCents: 0,
  nextMonthLabel: 'November',
  monthShortLabel: 'Oct',
  ...overrides,
});

const ids = (result: ReturnType<typeof buildZbbInsights>): string[] =>
  result.suggestions.map((s) => s.id);

describe('buildZbbInsights health', () => {
  it('flags a category that will run out before month end at the current pace', () => {
    // day 10 of 31: $300 spent of $400 means $30/day, empty around day 13
    const result = buildZbbInsights(
      input({
        today: { day: 10, daysInMonth: 31 },
        categories: [cat('Dining', { assigned: 400, spent: 300 })],
      }),
    );
    expect(result.health[0]).toEqual(
      expect.objectContaining({ status: 'at-risk', runOutDay: 13, availableCents: 10000 }),
    );
  });

  it('does not project pace for a past month', () => {
    const result = buildZbbInsights(
      input({ categories: [cat('Dining', { assigned: 400, spent: 300 })] }),
    );
    expect(result.health[0].status).toBe('funded');
    expect(result.health[0].runOutDay).toBeNull();
  });

  it('orders overspent first (worst first), then at-risk, then below target, then on track', () => {
    const result = buildZbbInsights(
      input({
        today: { day: 10, daysInMonth: 31 },
        categories: [
          cat('Rent', { assigned: 1800, spent: 1800 }),
          cat('Gifts', { assigned: 50, target: 100 }),
          cat('Dining', { assigned: 400, spent: 300 }),
          cat('Fuel', { assigned: 100, spent: 120 }),
          cat('Groceries', { assigned: 500, spent: 650 }),
        ],
      }),
    );
    expect(result.health.map((h) => [h.categoryName, h.status])).toEqual([
      ['Groceries', 'overspent'],
      ['Fuel', 'overspent'],
      ['Dining', 'at-risk'],
      ['Gifts', 'underfunded'],
      ['Rent', 'funded'],
    ]);
    expect(result.overspentCents).toBe(17000);
    expect(result.targetShortfallCents).toBe(5000);
  });

  it('leaves out empty categories with no target', () => {
    const result = buildZbbInsights(input({ categories: [cat('Unused', {})] }));
    expect(result.health).toEqual([]);
  });
});

describe('buildZbbInsights allocation', () => {
  it('lists the top categories by available, buckets the rest and adds Ready to Assign', () => {
    const categories = ['A', 'B', 'C', 'D', 'E', 'F', 'G'].map((name, i) =>
      cat(name, { assigned: (7 - i) * 100 }),
    );
    const result = buildZbbInsights(input({ categories, readyToAssignCents: 5000 }));
    expect(result.allocation.map((s) => [s.kind, s.label, s.cents])).toEqual([
      ['category', 'A', 70000],
      ['category', 'B', 60000],
      ['category', 'C', 50000],
      ['category', 'D', 40000],
      ['category', 'E', 30000],
      ['other', '2 categories more', 30000],
      ['ready', 'Ready to assign', 5000],
    ]);
  });
});

describe('buildZbbInsights suggestions', () => {
  it('puts over-assignment first, then overspending', () => {
    const result = buildZbbInsights(
      input({
        readyToAssignCents: -2000,
        categories: [cat('Groceries', { assigned: 500, spent: 600 })],
      }),
    );
    expect(ids(result)).toEqual(['over-assigned', 'overspent']);
  });

  it('names the smallest category that can cover an overspend, sparing big savings', () => {
    const result = buildZbbInsights(
      input({
        categories: [
          cat('Groceries', { assigned: 500, spent: 600 }),
          cat('Emergency fund', { assigned: 3000 }),
          cat('Fun', { assigned: 400 }),
          cat('Gifts', { assigned: 50 }),
        ],
      }),
    );
    const overspent = result.suggestions.find((s) => s.id === 'overspent');
    expect(overspent?.title).toBe('Groceries is overspent by $100.00');
    expect(overspent?.detail).toContain('Cover it from Fun');
  });

  it('suggests Ready to Assign when no category can cover it', () => {
    const result = buildZbbInsights(
      input({
        readyToAssignCents: 20000,
        categories: [cat('Groceries', { assigned: 500, spent: 600 })],
      }),
    );
    expect(result.suggestions.find((s) => s.id === 'overspent')?.detail).toContain(
      'Assign $100.00 from Ready to Assign',
    );
  });

  it('says every target can be funded when Ready to Assign covers the gap', () => {
    const result = buildZbbInsights(
      input({
        readyToAssignCents: 30000,
        categories: [cat('Gifts', { assigned: 50, target: 150 })],
      }),
    );
    expect(result.suggestions.find((s) => s.id === 'targets')?.title).toBe(
      'You can fund every target now',
    );
    // what's left after the targets is still waiting for a job
    expect(result.suggestions.find((s) => s.id === 'idle')?.title).toBe(
      '$200.00 is waiting for a job',
    );
  });

  it('points idle money at next month', () => {
    const result = buildZbbInsights(input({ readyToAssignCents: 50000 }));
    const idle = result.suggestions.find((s) => s.id === 'idle');
    expect(idle?.detail).toContain('Assign it to November');
    expect(idle?.action).toEqual({ kind: 'budgets', month: 202611, label: 'Plan November' });
  });

  it('flags uncategorized spending with a categorize action', () => {
    const result = buildZbbInsights(input({ uncategorized: { count: 2, cents: 4550 } }));
    expect(result.suggestions[0]).toEqual(
      expect.objectContaining({
        id: 'uncategorized',
        title: '2 expenses without a category',
        action: { kind: 'categorize', label: 'Categorize' },
      }),
    );
  });

  it('says all is well when there is nothing to do', () => {
    const result = buildZbbInsights(
      input({ categories: [cat('Rent', { assigned: 1800, spent: 1800 })] }),
    );
    expect(ids(result)).toEqual(['all-good']);
  });

  it('caps the list at five', () => {
    const result = buildZbbInsights(
      input({
        today: { day: 10, daysInMonth: 31 },
        readyToAssignCents: -100,
        uncategorized: { count: 1, cents: 100 },
        categories: [
          cat('Groceries', { assigned: 500, spent: 600 }),
          cat('Dining', { assigned: 400, spent: 300 }),
          cat('Gifts', { assigned: 50, target: 100 }),
        ],
      }),
    );
    expect(result.suggestions.length).toBeLessThanOrEqual(5);
    expect(ids(result)).toEqual([
      'over-assigned',
      'overspent',
      'uncategorized',
      'at-risk',
      'targets',
    ]);
  });
});
