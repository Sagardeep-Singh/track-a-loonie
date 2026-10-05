import { z } from 'zod';

export const USER_DATA_FORMAT_VERSION = 2;
/** v1 predates zero-based budgeting; its files still import, with the
 * zero-based fields falling back to their defaults. */
const SUPPORTED_FORMAT_VERSIONS = [1, USER_DATA_FORMAT_VERSION];
/** Enforced by the route before this schema even runs — see the byte-length
 * re-check in `app/api/settings/import/route.ts`. Exported so the client's
 * size precheck and error copy can derive from the same number. */
export const MAX_IMPORT_BYTES = 10 * 1024 * 1024;
/** Sum of rows across every array in `data`, checked below. Bounds
 * worst-case validation/transaction time independently of JSON verbosity. */
export const MAX_IMPORT_RECORDS = 50_000;

// Money is stored as `@db.Decimal(12, 2)` everywhere, so a valid file always
// carries exactly two decimal places — this also doubles as the
// non-negative check for every unsigned field, since the pattern has no
// leading `-`.
const unsignedDecimal = z.string().regex(/^\d+\.\d{2}$/, 'Amount must look like "12.34".');
const signedDecimal = z
  .string()
  .regex(/^-?\d+\.\d{2}$/, 'Amount must look like "12.34" or "-12.34".');

const accountSchema = z.strictObject({
  id: z.string().min(1),
  name: z.string().min(1),
  type: z.enum(['CHECKING', 'SAVINGS', 'CREDIT_CARD', 'CASH']),
  startingBalance: signedDecimal,
  statementDay: z.number().int().min(1).max(28).nullable(),
  /** v2+; absent in v1 files, where import derives it from `type` */
  onBudget: z.boolean().optional(),
  createdAt: z.coerce.date(),
});

const categorySchema = z.strictObject({
  id: z.string().min(1),
  name: z.string().min(1),
  isDefault: z.boolean(),
  createdAt: z.coerce.date(),
});

const importBatchSchema = z.strictObject({
  id: z.string().min(1),
  accountId: z.string().min(1),
  filename: z.string().min(1),
  filenameNormalized: z.string().min(1),
  status: z.enum(['ACTIVE', 'UNDONE']),
  rowCount: z.number().int().min(0),
  importedCount: z.number().int().min(0),
  skippedDuplicates: z.number().int().min(0),
  dateFrom: z.coerce.date(),
  dateTo: z.coerce.date(),
  createdAt: z.coerce.date(),
  undoneAt: z.coerce.date().nullable(),
});

const transactionSchema = z.strictObject({
  id: z.string().min(1),
  accountId: z.string().min(1),
  categoryId: z.string().min(1).nullable(),
  amount: unsignedDecimal,
  type: z.enum(['INCOME', 'EXPENSE']),
  date: z.coerce.date(),
  payee: z.string().max(120).nullable(),
  note: z.string().max(280).nullable(),
  importBatchId: z.string().min(1).nullable(),
  isPayment: z.boolean(),
  isTransfer: z.boolean(),
  transferMatchId: z.string().min(1).nullable(),
  isReimbursable: z.boolean(),
  reimbursementExpectedAmount: unsignedDecimal.nullable(),
  reimbursementCompletedAt: z.coerce.date().nullable(),
  skippedAt: z.coerce.date().nullable(),
  createdAt: z.coerce.date(),
});

// YYYYMM, 1900_01–9999_12, month part 01–12 — matches Budget.month's own
// documented range everywhere else this int is validated.
const budgetMonth = z
  .number()
  .int()
  .refine(
    (month) => month >= 190001 && month <= 999912 && month % 100 >= 1 && month % 100 <= 12,
    'Invalid budget month.',
  );

const budgetSchema = z.strictObject({
  id: z.string().min(1),
  categoryId: z.string().min(1),
  month: budgetMonth,
  limitAmount: unsignedDecimal,
});

const categoryAssignmentSchema = z.strictObject({
  id: z.string().min(1),
  categoryId: z.string().min(1),
  month: budgetMonth,
  amount: signedDecimal,
});

const budgetSettingsSchema = z.strictObject({
  mode: z.enum(['LIMITS', 'ZERO_BASED']),
  zbbStartMonth: budgetMonth.nullable(),
});

const categoryRuleSchema = z.strictObject({
  id: z.string().min(1),
  categoryId: z.string().min(1),
  matchText: z.string().min(1),
  priority: z.number().int(),
});

const reimbursementLinkSchema = z.strictObject({
  id: z.string().min(1),
  expenseTransactionId: z.string().min(1),
  incomeTransactionId: z.string().min(1),
  amount: unsignedDecimal,
  createdAt: z.coerce.date(),
});

const dataSchema = z.strictObject({
  accounts: z.array(accountSchema),
  categories: z.array(categorySchema),
  importBatches: z.array(importBatchSchema),
  transactions: z.array(transactionSchema),
  budgets: z.array(budgetSchema),
  categoryRules: z.array(categoryRuleSchema),
  reimbursementLinks: z.array(reimbursementLinkSchema),
  /** v2+, like `budgetSettings`; absent in v1 files */
  categoryAssignments: z.array(categoryAssignmentSchema).optional(),
  /** null = the user never changed the budgeting mode (LIMITS) */
  budgetSettings: budgetSettingsSchema.nullable().optional(),
});

const findDuplicateKey = (keys: string[]): string | null => {
  const seen = new Set<string>();
  for (const key of keys) {
    if (seen.has(key)) return key;
    seen.add(key);
  }
  return null;
};

export const userDataFileSchema = z
  .strictObject({
    // Checked first and given its own message so a version mismatch reads
    // as "wrong version", not as a wall of unrelated shape errors.
    formatVersion: z.number().refine((v) => SUPPORTED_FORMAT_VERSIONS.includes(v), {
      message: 'This file was made by a different version of Track a Loonie.',
    }),
    exportedAt: z.string(), // metadata only, ignored on import
    user: z.strictObject({ email: z.string(), name: z.string().nullable() }),
    data: dataSchema,
  })
  .superRefine((file, ctx) => {
    const { data } = file;
    const categoryAssignments = data.categoryAssignments ?? [];
    const totalRecords =
      data.accounts.length +
      data.categories.length +
      data.importBatches.length +
      data.transactions.length +
      data.budgets.length +
      data.categoryRules.length +
      data.reimbursementLinks.length +
      categoryAssignments.length;
    if (totalRecords > MAX_IMPORT_RECORDS) {
      ctx.addIssue({
        code: 'custom',
        path: ['data'],
        message: `This file has ${totalRecords} records, over the ${MAX_IMPORT_RECORDS.toLocaleString()} limit.`,
      });
      // Every other check below is relative to record contents; skipping
      // them on an oversized file avoids a slow validation pass whose
      // result is discarded anyway.
      return;
    }

    // --- id uniqueness within each array ---
    const idDuplicateChecks: [string, { id: string }[]][] = [
      ['accounts', data.accounts],
      ['categories', data.categories],
      ['importBatches', data.importBatches],
      ['transactions', data.transactions],
      ['budgets', data.budgets],
      ['categoryRules', data.categoryRules],
      ['reimbursementLinks', data.reimbursementLinks],
      ['categoryAssignments', categoryAssignments],
    ];
    for (const [path, rows] of idDuplicateChecks) {
      const duplicate = findDuplicateKey(rows.map((r) => r.id));
      if (duplicate) {
        ctx.addIssue({
          code: 'custom',
          path: ['data', path],
          message: `Duplicate id "${duplicate}" in ${path}.`,
        });
      }
    }

    // --- referential integrity ---
    const accountIds = new Set(data.accounts.map((a) => a.id));
    const categoryIds = new Set(data.categories.map((c) => c.id));
    const importBatchIds = new Set(data.importBatches.map((b) => b.id));
    const transactionIds = new Set(data.transactions.map((t) => t.id));

    data.importBatches.forEach((batch, i) => {
      if (!accountIds.has(batch.accountId)) {
        ctx.addIssue({
          code: 'custom',
          path: ['data', 'importBatches', i, 'accountId'],
          message: 'References an account not in this file.',
        });
      }
    });

    const expectedByExpenseId = new Map<string, number>();
    for (const t of data.transactions) {
      if (t.isReimbursable && t.reimbursementExpectedAmount !== null) {
        expectedByExpenseId.set(t.id, Number(t.reimbursementExpectedAmount));
      }
    }
    const transferMatchGroups = new Map<string, number>();

    data.transactions.forEach((t, i) => {
      const path = (field: string): (string | number)[] => ['data', 'transactions', i, field];
      if (!accountIds.has(t.accountId)) {
        ctx.addIssue({ code: 'custom', path: path('accountId'), message: 'Unknown account.' });
      }
      if (t.categoryId !== null && !categoryIds.has(t.categoryId)) {
        ctx.addIssue({ code: 'custom', path: path('categoryId'), message: 'Unknown category.' });
      }
      if (t.importBatchId !== null && !importBatchIds.has(t.importBatchId)) {
        ctx.addIssue({
          code: 'custom',
          path: path('importBatchId'),
          message: 'Unknown import batch.',
        });
      }

      // isReimbursable <=> reimbursementExpectedAmount !== null
      if (t.isReimbursable !== (t.reimbursementExpectedAmount !== null)) {
        ctx.addIssue({
          code: 'custom',
          path: path('isReimbursable'),
          message: 'isReimbursable must agree with reimbursementExpectedAmount.',
        });
      }
      if (
        t.reimbursementExpectedAmount !== null &&
        Number(t.reimbursementExpectedAmount) > Number(t.amount)
      ) {
        ctx.addIssue({
          code: 'custom',
          path: path('reimbursementExpectedAmount'),
          message: 'Cannot exceed the transaction amount.',
        });
      }
      if (t.isReimbursable && (t.isTransfer || t.isPayment)) {
        ctx.addIssue({
          code: 'custom',
          path: path('isReimbursable'),
          message: 'A reimbursable expense cannot also be a transfer or a card payment.',
        });
      }
      if (t.reimbursementCompletedAt !== null && !t.isReimbursable) {
        ctx.addIssue({
          code: 'custom',
          path: path('reimbursementCompletedAt'),
          message: 'Only a reimbursable expense can be marked fully reimbursed.',
        });
      }
      if (t.transferMatchId !== null) {
        transferMatchGroups.set(
          t.transferMatchId,
          (transferMatchGroups.get(t.transferMatchId) ?? 0) + 1,
        );
      }
    });

    for (const [matchId, count] of transferMatchGroups) {
      if (count > 2) {
        ctx.addIssue({
          code: 'custom',
          path: ['data', 'transactions'],
          message: `transferMatchId "${matchId}" is shared by ${count} transactions; at most 2 allowed.`,
        });
      }
    }

    data.budgets.forEach((budget, i) => {
      if (!categoryIds.has(budget.categoryId)) {
        ctx.addIssue({
          code: 'custom',
          path: ['data', 'budgets', i, 'categoryId'],
          message: 'Unknown category.',
        });
      }
    });
    const budgetKeyDuplicate = findDuplicateKey(
      data.budgets.map((b) => `${b.categoryId}:${b.month}`),
    );
    if (budgetKeyDuplicate) {
      ctx.addIssue({
        code: 'custom',
        path: ['data', 'budgets'],
        message: 'Duplicate budget for the same category and month.',
      });
    }

    categoryAssignments.forEach((assignment, i) => {
      if (!categoryIds.has(assignment.categoryId)) {
        ctx.addIssue({
          code: 'custom',
          path: ['data', 'categoryAssignments', i, 'categoryId'],
          message: 'Unknown category.',
        });
      }
    });
    if (findDuplicateKey(categoryAssignments.map((a) => `${a.categoryId}:${a.month}`))) {
      ctx.addIssue({
        code: 'custom',
        path: ['data', 'categoryAssignments'],
        message: 'Duplicate assignment for the same category and month.',
      });
    }

    data.categoryRules.forEach((rule, i) => {
      if (!categoryIds.has(rule.categoryId)) {
        ctx.addIssue({
          code: 'custom',
          path: ['data', 'categoryRules', i, 'categoryId'],
          message: 'Unknown category.',
        });
      }
    });

    const categoryNameDuplicate = findDuplicateKey(
      data.categories.map((c) => c.name.trim().toLowerCase()),
    );
    if (categoryNameDuplicate) {
      ctx.addIssue({
        code: 'custom',
        path: ['data', 'categories'],
        message: `Duplicate category name "${categoryNameDuplicate}".`,
      });
    }

    const linkedByExpenseId = new Map<string, number>();
    data.reimbursementLinks.forEach((link, i) => {
      const path = (field: string): (string | number)[] => ['data', 'reimbursementLinks', i, field];
      if (!transactionIds.has(link.expenseTransactionId)) {
        ctx.addIssue({
          code: 'custom',
          path: path('expenseTransactionId'),
          message: 'Unknown transaction.',
        });
      }
      if (!transactionIds.has(link.incomeTransactionId)) {
        ctx.addIssue({
          code: 'custom',
          path: path('incomeTransactionId'),
          message: 'Unknown transaction.',
        });
      }
      linkedByExpenseId.set(
        link.expenseTransactionId,
        (linkedByExpenseId.get(link.expenseTransactionId) ?? 0) + Number(link.amount),
      );
    });
    const linkKeyDuplicate = findDuplicateKey(
      data.reimbursementLinks.map((l) => `${l.expenseTransactionId}:${l.incomeTransactionId}`),
    );
    if (linkKeyDuplicate) {
      ctx.addIssue({
        code: 'custom',
        path: ['data', 'reimbursementLinks'],
        message: 'Duplicate reimbursement link between the same two transactions.',
      });
    }

    const expenseById = new Map(data.transactions.map((t) => [t.id, t]));
    const incomeById = expenseById;
    data.reimbursementLinks.forEach((link, i) => {
      const expense = expenseById.get(link.expenseTransactionId);
      const income = incomeById.get(link.incomeTransactionId);
      if (expense && (expense.type !== 'EXPENSE' || !expense.isReimbursable)) {
        ctx.addIssue({
          code: 'custom',
          path: ['data', 'reimbursementLinks', i, 'expenseTransactionId'],
          message: 'Must reference a reimbursable expense.',
        });
      }
      if (income && income.type !== 'INCOME') {
        ctx.addIssue({
          code: 'custom',
          path: ['data', 'reimbursementLinks', i, 'incomeTransactionId'],
          message: 'Must reference an income transaction.',
        });
      }
    });
    for (const [expenseId, linkedTotal] of linkedByExpenseId) {
      const expected = expectedByExpenseId.get(expenseId);
      if (expected !== undefined && linkedTotal > expected) {
        ctx.addIssue({
          code: 'custom',
          path: ['data', 'reimbursementLinks'],
          message: `Linked total for expense "${expenseId}" exceeds its expected reimbursement.`,
        });
      }
    }
  });

export type UserDataFile = z.infer<typeof userDataFileSchema>;
