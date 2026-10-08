import { z } from 'zod';
import { ACCOUNT_TYPE_VALUES } from '@/lib/account-types';

export const accountTypeSchema = z.enum(ACCOUNT_TYPE_VALUES);

export const createAccountSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    type: accountTypeSchema,
    startingBalance: z.coerce.number().finite().default(0),
    statementDay: z.coerce.number().int().min(1).max(28).nullable().optional(),
    onBudget: z.boolean().optional(),
  })
  .refine((data) => data.type === 'CREDIT_CARD' || !data.statementDay, {
    message: 'statementDay only applies to credit card accounts',
    path: ['statementDay'],
  });

// Partial update: type may be omitted (editing an existing card without
// changing its type), so the CREDIT_CARD-only constraint on statementDay is
// enforced in the account service instead, where the existing type is known.
export const updateAccountSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  type: accountTypeSchema.optional(),
  startingBalance: z.coerce.number().finite().optional(),
  statementDay: z.coerce.number().int().min(1).max(28).nullable().optional(),
  onBudget: z.boolean().optional(),
});

export type CreateAccountInput = z.infer<typeof createAccountSchema>;
export type UpdateAccountInput = z.infer<typeof updateAccountSchema>;
