import { describe, expect, it } from 'vitest';
import {
  budgetModeSchema,
  moveMoneySchema,
  setAssignmentSchema,
} from '@/lib/validators/zero-based';

describe('zero-based validators', () => {
  it('accepts only the two budget modes', () => {
    expect(budgetModeSchema.safeParse({ mode: 'ZERO_BASED' }).success).toBe(true);
    expect(budgetModeSchema.safeParse({ mode: 'ENVELOPES' }).success).toBe(false);
  });

  it('allows a negative or zero assignment', () => {
    expect(
      setAssignmentSchema.safeParse({ categoryId: 'c', month: 202610, amount: '-12.50' }).success,
    ).toBe(true);
    expect(
      setAssignmentSchema.safeParse({ categoryId: 'c', month: 202610, amount: 0 }).success,
    ).toBe(true);
  });

  it('rejects more than two decimal places, a bad month, and non-numbers', () => {
    expect(
      setAssignmentSchema.safeParse({ categoryId: 'c', month: 202610, amount: '1.005' }).success,
    ).toBe(false);
    expect(
      setAssignmentSchema.safeParse({ categoryId: 'c', month: 1999, amount: '1' }).success,
    ).toBe(false);
    expect(
      setAssignmentSchema.safeParse({ categoryId: 'c', month: 202610, amount: 'abc' }).success,
    ).toBe(false);
    expect(
      setAssignmentSchema.safeParse({ categoryId: '', month: 202610, amount: 1 }).success,
    ).toBe(false);
  });

  it('needs a positive amount and two different categories to move money', () => {
    const base = { fromCategoryId: 'a', toCategoryId: 'b', month: 202610 };
    expect(moveMoneySchema.safeParse({ ...base, amount: '10.00' }).success).toBe(true);
    expect(moveMoneySchema.safeParse({ ...base, amount: 0 }).success).toBe(false);
    expect(moveMoneySchema.safeParse({ ...base, amount: -5 }).success).toBe(false);
    expect(moveMoneySchema.safeParse({ ...base, toCategoryId: 'a', amount: '10.00' }).success).toBe(
      false,
    );
  });
});
