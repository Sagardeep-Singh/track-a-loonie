import { z } from 'zod';
import { monthOfDate, monthsBetween } from '@/lib/date';
import { parseDateParam } from '@/lib/period-selection';
import { calendarDateSchema } from '@/lib/validators/date';
import { SPREAD_MAX_MONTHS, SPREAD_MAX_START_OFFSET, SPREAD_MIN_MONTHS } from '@/lib/spread';
import { TRANSACTIONS_PAGE_SIZE } from '@/lib/transactions/transactions-page-query';

export const transactionTypeSchema = z.enum(['INCOME', 'EXPENSE']);

const transactionFieldsSchema = z.object({
  accountId: z.string().min(1),
  categoryId: z.string().min(1).nullable().optional(),
  amount: z.coerce.number().positive(),
  type: transactionTypeSchema,
  date: calendarDateSchema,
  payee: z.string().trim().max(120).optional(),
  note: z.string().trim().max(280).optional(),
  isPayment: z.coerce.boolean().default(false),
  isTransfer: z.coerce.boolean().default(false),
  isReimbursable: z.coerce.boolean().default(false),
  reimbursementExpectedAmount: z.coerce.number().positive().nullable().optional(),
  reimbursementCompleted: z.coerce.boolean().optional(),
  spreadStartMonth: z.coerce
    .number()
    .int()
    .min(190001)
    .max(299912)
    .refine((m) => m % 100 >= 1 && m % 100 <= 12, 'Invalid month')
    .nullable()
    .optional(),
  spreadMonths: z.coerce
    .number()
    .int()
    .min(SPREAD_MIN_MONTHS, `Spread over at least ${SPREAD_MIN_MONTHS} months`)
    .max(SPREAD_MAX_MONTHS, `Spread over at most ${SPREAD_MAX_MONTHS} months`)
    .nullable()
    .optional(),
});

/**
 * Cross-field checks that are self-contained within one payload — no DB state.
 * Applied identically to create and update (the latter over a fully partial
 * shape), so every check below tolerates any of its fields being `undefined`.
 * Everything that depends on existing DB state (current linked totals, the
 * expense's amount on a partial PATCH) is enforced in the service instead.
 */
const refineReimbursable = (
  v: {
    type?: 'INCOME' | 'EXPENSE';
    amount?: number;
    isTransfer?: boolean;
    isPayment?: boolean;
    isReimbursable?: boolean;
    reimbursementExpectedAmount?: number | null;
    reimbursementCompleted?: boolean;
  },
  ctx: z.RefinementCtx,
): void => {
  if (v.isReimbursable === true) {
    if (v.type !== undefined && v.type !== 'EXPENSE') {
      ctx.addIssue({
        code: 'custom',
        path: ['isReimbursable'],
        message: 'Only an expense can be reimbursable',
      });
    }
    if (v.isTransfer === true) {
      ctx.addIssue({
        code: 'custom',
        path: ['isReimbursable'],
        message: 'A reimbursable expense cannot also be a transfer',
      });
    }
    if (v.isPayment === true) {
      ctx.addIssue({
        code: 'custom',
        path: ['isReimbursable'],
        message: 'A reimbursable expense cannot also be a card payment',
      });
    }
    if (v.reimbursementExpectedAmount == null) {
      ctx.addIssue({
        code: 'custom',
        path: ['reimbursementExpectedAmount'],
        message: 'Expected reimbursement amount is required',
      });
    } else if (v.amount !== undefined && v.reimbursementExpectedAmount > v.amount) {
      ctx.addIssue({
        code: 'custom',
        path: ['reimbursementExpectedAmount'],
        message: 'The expected reimbursement cannot exceed the expense amount',
      });
    }
  } else if (v.isReimbursable === false && v.reimbursementExpectedAmount != null) {
    ctx.addIssue({
      code: 'custom',
      path: ['reimbursementExpectedAmount'],
      message: 'A non-reimbursable expense cannot have an expected reimbursement amount',
    });
  }

  if (v.reimbursementCompleted === true && v.isReimbursable === false) {
    ctx.addIssue({
      code: 'custom',
      path: ['reimbursementCompleted'],
      message: 'Only a reimbursable expense can be marked fully reimbursed',
    });
  }
};

/**
 * Payload-only spread checks, same shape rules as `refineReimbursable`: every
 * field may be `undefined` on a partial update. A spread is "set" when
 * `spreadMonths` is a number; both spread fields travel together. The merged
 * state on a partial PATCH is re-checked in the service.
 */
const refineSpread = (
  v: {
    type?: 'INCOME' | 'EXPENSE';
    date?: Date;
    isTransfer?: boolean;
    isPayment?: boolean;
    isReimbursable?: boolean;
    spreadStartMonth?: number | null;
    spreadMonths?: number | null;
  },
  ctx: z.RefinementCtx,
): void => {
  const startSet = v.spreadStartMonth != null;
  const monthsSet = v.spreadMonths != null;
  if (v.spreadStartMonth !== undefined || v.spreadMonths !== undefined) {
    if (startSet !== monthsSet) {
      ctx.addIssue({
        code: 'custom',
        path: [startSet ? 'spreadMonths' : 'spreadStartMonth'],
        message: 'Spread needs both a start month and a number of months',
      });
      return;
    }
  }
  if (!monthsSet) return;

  if (v.type !== undefined && v.type !== 'EXPENSE') {
    ctx.addIssue({
      code: 'custom',
      path: ['spreadMonths'],
      message: 'Only an expense can be spread',
    });
  }
  if (v.isTransfer === true) {
    ctx.addIssue({
      code: 'custom',
      path: ['spreadMonths'],
      message: 'A transfer cannot be spread',
    });
  }
  if (v.isPayment === true) {
    ctx.addIssue({
      code: 'custom',
      path: ['spreadMonths'],
      message: 'A card payment cannot be spread',
    });
  }
  if (v.isReimbursable === true) {
    ctx.addIssue({
      code: 'custom',
      path: ['spreadMonths'],
      message: 'A reimbursable expense cannot also be spread',
    });
  }
  if (
    v.date !== undefined &&
    !Number.isNaN(v.date.getTime()) &&
    Math.abs(monthsBetween(monthOfDate(v.date), v.spreadStartMonth!)) > SPREAD_MAX_START_OFFSET
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['spreadStartMonth'],
      message: `The spread must start within ${SPREAD_MAX_START_OFFSET} months of the transaction date`,
    });
  }
};

export const createTransactionSchema = transactionFieldsSchema
  .superRefine(refineReimbursable)
  .superRefine(refineSpread);
export const updateTransactionSchema = transactionFieldsSchema
  .partial()
  .superRefine(refineReimbursable)
  .superRefine(refineSpread);

export const listTransactionsQuerySchema = z.object({
  accountId: z.string().optional(),
  categoryId: z.string().optional(),
  batchId: z.string().optional(),
  from: calendarDateSchema.optional(),
  to: calendarDateSchema.optional(),
});

const csvIds = z
  .string()
  .optional()
  .catch(undefined)
  .transform((v) =>
    v
      ? v
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : [],
  );

const lenientDate = z
  .string()
  .nullish()
  .catch(null)
  .transform((v) => parseDateParam(v));

const lenientFlag = z
  .enum(['true', 'false'])
  .catch('false')
  .transform((v) => v === 'true');

/**
 * `GET /api/transactions?paginated=1`. Filters are lenient (bad values mean
 * "no filter"); `limit` and `cursor` are strict, since our client sends them.
 */
export const transactionsPageQuerySchema = z.object({
  from: lenientDate,
  to: lenientDate,
  accountIds: csvIds,
  categoryIds: csvIds,
  payee: z.string().max(120).catch(''),
  type: transactionTypeSchema.nullish().catch(null),
  amountMin: z.string().nullish().catch(null),
  amountMax: z.string().nullish().catch(null),
  hideTransfers: lenientFlag,
  hidePayments: lenientFlag,
  uncategorizedOnly: lenientFlag,
  pendingReimbursementsOnly: lenientFlag,
  mobileSearch: z.string().max(120).catch(''),
  limit: z.coerce.number().int().min(1).max(100).default(TRANSACTIONS_PAGE_SIZE),
  cursor: z.string().max(200).optional(),
});

export type CreateTransactionInput = z.infer<typeof createTransactionSchema>;
export type UpdateTransactionInput = z.infer<typeof updateTransactionSchema>;
export type ListTransactionsQuery = z.infer<typeof listTransactionsQuerySchema>;
export type TransactionsPageQuery = z.infer<typeof transactionsPageQuerySchema>;
