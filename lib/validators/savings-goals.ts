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

const goalAmountsSchema = z.object({
  targetAmount: moneySchema.refine((v) => v > 0, { message: 'Target must be positive' }),
  targetMonth: monthSchema,
  startingAmount: moneySchema
    .refine((v) => v >= 0, { message: 'Starting amount cannot be negative' })
    .default(0),
});

const startingBelowTarget = (d: { targetAmount: number; startingAmount: number }): boolean =>
  d.startingAmount < d.targetAmount;
const startingBelowTargetIssue = {
  message: 'Already saved must be less than the target',
  path: ['startingAmount'],
};

/** a goal on an existing category, or on a new one created alongside it */
export const createSavingsGoalSchema = goalAmountsSchema
  .extend({
    categoryId: z.string().min(1).optional(),
    newCategoryName: z.string().trim().min(1).max(60).optional(),
  })
  .refine((d) => Boolean(d.categoryId) !== Boolean(d.newCategoryName), {
    message: 'Pick a category or name a new one',
    path: ['categoryId'],
  })
  .refine(startingBelowTarget, startingBelowTargetIssue);

export const updateSavingsGoalSchema = goalAmountsSchema.refine(
  startingBelowTarget,
  startingBelowTargetIssue,
);

export const archiveSavingsGoalSchema = z.object({
  archived: z.boolean(),
});

/** `?month=` on the goal list; defaults to the current month in the route */
export const savingsGoalsQuerySchema = z.object({
  month: monthSchema.optional(),
  includeArchived: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
});

export type CreateSavingsGoalInput = z.infer<typeof createSavingsGoalSchema>;
export type UpdateSavingsGoalInput = z.infer<typeof updateSavingsGoalSchema>;
export type ArchiveSavingsGoalInput = z.infer<typeof archiveSavingsGoalSchema>;
