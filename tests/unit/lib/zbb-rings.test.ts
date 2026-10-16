import { describe, expect, it } from 'vitest';
import type { CategoryHealth } from '@/lib/budgets/zero-based-insights';
import { zbbBudgetRings } from '@/lib/dashboard/zbb-rings';

const health = (
  name: string,
  cents: { funded: number; activity: number; available: number },
): CategoryHealth => ({
  categoryId: name.toLowerCase(),
  categoryName: name,
  status: cents.available < 0 ? 'overspent' : 'funded',
  fundedCents: cents.funded,
  activityCents: cents.activity,
  availableCents: cents.available,
  runOutDay: null,
  targetShortfallCents: 0,
});

describe('zbbBudgetRings', () => {
  it('measures spending against what the category had this month', () => {
    const [ring] = zbbBudgetRings([
      health('Groceries', { funded: 60000, activity: 42000, available: 18000 }),
    ]);
    expect(ring).toEqual({
      id: 'groceries',
      categoryId: 'groceries',
      categoryName: 'Groceries',
      fraction: 0.7,
      pctLabel: '70%',
      left: '180.00',
      over: false,
    });
  });

  it('marks an overspent category and caps the label at 100%', () => {
    const [ring] = zbbBudgetRings([
      health('Dining', { funded: 20000, activity: 23000, available: -3000 }),
    ]);
    expect(ring.over).toBe(true);
    expect(ring.left).toBe('Over by 30.00');
    expect(ring.fraction).toBeCloseTo(1.15);
    expect(ring.pctLabel).toBe('100%');
  });

  it('reads spending with nothing funded as fully over, and nothing as empty', () => {
    const [spent, idle] = zbbBudgetRings([
      health('Fun', { funded: 0, activity: 1000, available: -1000 }),
      health('Gifts', { funded: 0, activity: 0, available: 0 }),
    ]);
    expect(spent.fraction).toBe(2);
    expect(idle.fraction).toBe(0);
  });

  it('shows at most four, in the order given', () => {
    const rings = zbbBudgetRings(
      ['A', 'B', 'C', 'D', 'E'].map((n) => health(n, { funded: 100, activity: 0, available: 100 })),
    );
    expect(rings.map((r) => r.categoryName)).toEqual(['A', 'B', 'C', 'D']);
  });
});
