import { z } from 'zod';

const monthSchema = z.coerce.number().int().min(190001).max(299912);

// two decimal places max, same money shape the rest of the app stores
const moneySchema = z.coerce
  .number()
  .finite()
  .refine((v) => Math.round(v * 100) === Number((v * 100).toFixed(6)), {
    message: 'Use at most two decimal places',
  })
  .refine((v) => Math.abs(v) < 1e10, { message: 'Amount is too large' });

export const budgetModeSchema = z.object({
  mode: z.enum(['LIMITS', 'ZERO_BASED']),
});

/** absolute amount assigned to one category for one month; negative is allowed
 * (money moved out of a category funded in an earlier month) */
export const setAssignmentSchema = z.object({
  categoryId: z.string().min(1),
  month: monthSchema,
  amount: moneySchema,
});

export const moveMoneySchema = z
  .object({
    fromCategoryId: z.string().min(1),
    toCategoryId: z.string().min(1),
    month: monthSchema,
    amount: moneySchema.refine((v) => v > 0, { message: 'Amount must be positive' }),
  })
  .refine((d) => d.fromCategoryId !== d.toCategoryId, {
    message: 'Pick two different categories',
    path: ['toCategoryId'],
  });

export const assignToTargetsSchema = z.object({
  month: monthSchema,
});

/** `?month=` on the zero-based month read */
export const zbbMonthQuerySchema = z.object({
  month: monthSchema,
});

export type BudgetModeInput = z.infer<typeof budgetModeSchema>;
export type SetAssignmentInput = z.infer<typeof setAssignmentSchema>;
export type MoveMoneyInput = z.infer<typeof moveMoneySchema>;
export type AssignToTargetsInput = z.infer<typeof assignToTargetsSchema>;
