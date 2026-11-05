import { describe, expect, it } from 'vitest';
import { readBudgetModeCookie } from '@/lib/budget-mode-cookie';

describe('readBudgetModeCookie', () => {
  it('reads the mode among other cookies', () => {
    expect(readBudgetModeCookie('a=1; tal_budget_mode=ZERO_BASED; b=2')).toBe('ZERO_BASED');
    expect(readBudgetModeCookie('tal_budget_mode=LIMITS')).toBe('LIMITS');
  });

  it('ignores a missing, unknown or look-alike cookie', () => {
    expect(readBudgetModeCookie('')).toBeNull();
    expect(readBudgetModeCookie('tal_budget_mode=ENVELOPES')).toBeNull();
    expect(readBudgetModeCookie('xtal_budget_mode=ZERO_BASED')).toBeNull();
  });
});
