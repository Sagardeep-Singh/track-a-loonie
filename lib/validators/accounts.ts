import { z } from 'zod';
import { ACCOUNT_TYPE_VALUES } from '@/lib/account-types';
import { calendarDateSchema } from '@/lib/validators/date';

export const accountTypeSchema = z.enum(ACCOUNT_TYPE_VALUES);

export const createAccountSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    type: accountTypeSchema,
    startingBalance: z.coerce.number().finite().default(0),
    statementDay: z.coerce.number().int().min(1).max(28).nullable().optional(),
    onBudget: z.boolean().optional(),
    tracksBalance: z.boolean().optional(),
    /** viewer's local date for the first balance update of a tracked account */
    startingBalanceDate: calendarDateSchema.optional(),
  })
  .refine((data) => data.type === 'CREDIT_CARD' || !data.statementDay, {
    message: 'statementDay only applies to credit card accounts',
    path: ['statementDay'],
  })
  .refine((data) => !(data.tracksBalance && data.onBudget), {
    message: 'A balance-tracked account is always off-budget',
    path: ['onBudget'],
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
  tracksBalance: z.boolean().optional(),
  startingBalanceDate: calendarDateSchema.optional(),
});

// One day of slack: the client sends the viewer's local date, which east of
// Greenwich can already be tomorrow in UTC.
const MAX_FUTURE_MS = 24 * 60 * 60 * 1000;

export const createBalanceUpdateSchema = z.object({
  // an empty field is a missing balance, not $0 (which z.coerce would make it)
  balance: z.preprocess((v) => (v === '' ? undefined : v), z.coerce.number().finite()),
  date: calendarDateSchema.refine(
    (date) => date.getTime() <= Date.now() + MAX_FUTURE_MS,
    'A balance update can’t be dated in the future',
  ),
  note: z.string().trim().max(200).optional(),
});

export type CreateAccountInput = z.infer<typeof createAccountSchema>;
export type UpdateAccountInput = z.infer<typeof updateAccountSchema>;
export type CreateBalanceUpdateInput = z.infer<typeof createBalanceUpdateSchema>;
