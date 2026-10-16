import type { CategoryHealth } from '@/lib/budgets/zero-based-insights';
import type { OverviewBudgetRing } from '@/lib/services/overview';

/** how many category rings the Overview shows, same as in limits mode */
export const ZBB_RING_COUNT = 4;

/**
 * Zero-based categories as Overview budget rings, so both modes share one
 * rings card. The fraction is spending against what the category had this
 * month (carried in plus assigned), the same number the Budgets table's mini
 * rings show. `health` is already ordered most urgent first.
 */
export const zbbBudgetRings = (health: CategoryHealth[]): OverviewBudgetRing[] =>
  health.slice(0, ZBB_RING_COUNT).map((h) => {
    const spent = Math.max(h.activityCents, 0);
    const fraction = h.fundedCents > 0 ? spent / h.fundedCents : spent > 0 ? 2 : 0;
    const over = h.availableCents < 0;
    const left = (Math.abs(h.availableCents) / 100).toFixed(2);
    return {
      id: h.categoryId,
      categoryId: h.categoryId,
      categoryName: h.categoryName,
      fraction,
      pctLabel: `${Math.round(Math.min(fraction, 1) * 100)}%`,
      left: over ? `Over by ${left}` : left,
      over,
    };
  });
