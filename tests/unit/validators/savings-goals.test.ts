import { describe, expect, it } from 'vitest';
import {
  createSavingsGoalSchema,
  savingsGoalsQuerySchema,
  updateSavingsGoalSchema,
} from '@/lib/validators/savings-goals';

const base = { targetAmount: '3000', targetMonth: 202708 };

describe('savings goal validators', () => {
  it('accepts an existing category or a new category name, not both or neither', () => {
    expect(createSavingsGoalSchema.safeParse({ ...base, categoryId: 'c1' }).success).toBe(true);
    expect(
      createSavingsGoalSchema.safeParse({ ...base, newCategoryName: ' Trip to Japan ' }).data
        ?.newCategoryName,
    ).toBe('Trip to Japan');
    expect(
      createSavingsGoalSchema.safeParse({ ...base, categoryId: 'c1', newCategoryName: 'Trip' })
        .success,
    ).toBe(false);
    expect(createSavingsGoalSchema.safeParse(base).success).toBe(false);
    expect(createSavingsGoalSchema.safeParse({ ...base, newCategoryName: '   ' }).success).toBe(
      false,
    );
  });

  it('defaults the starting amount to zero', () => {
    expect(createSavingsGoalSchema.parse({ ...base, categoryId: 'c1' }).startingAmount).toBe(0);
  });

  it('requires a positive target with at most two decimals', () => {
    expect(updateSavingsGoalSchema.safeParse({ ...base, targetAmount: 0 }).success).toBe(false);
    expect(updateSavingsGoalSchema.safeParse({ ...base, targetAmount: '-5' }).success).toBe(false);
    expect(updateSavingsGoalSchema.safeParse({ ...base, targetAmount: '10.005' }).success).toBe(
      false,
    );
  });

  it('keeps the starting amount between zero and the target', () => {
    expect(updateSavingsGoalSchema.safeParse({ ...base, startingAmount: '-1' }).success).toBe(
      false,
    );
    expect(updateSavingsGoalSchema.safeParse({ ...base, startingAmount: '3000' }).success).toBe(
      false,
    );
    expect(updateSavingsGoalSchema.safeParse({ ...base, startingAmount: '2999.99' }).success).toBe(
      true,
    );
  });

  it('rejects a malformed target month', () => {
    expect(updateSavingsGoalSchema.safeParse({ ...base, targetMonth: 2027 }).success).toBe(false);
    expect(updateSavingsGoalSchema.safeParse({ ...base, targetMonth: 'soon' }).success).toBe(
      false,
    );
  });

  it('parses the list query', () => {
    expect(savingsGoalsQuerySchema.parse({ month: '202610', includeArchived: 'true' })).toEqual({
      month: 202610,
      includeArchived: true,
    });
    expect(savingsGoalsQuerySchema.parse({})).toEqual({ includeArchived: false });
  });
});
