import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { defaultOnBudgetFor } from '@/lib/account-types';
import { prisma } from '@/lib/db/prisma';
import { spreadEndMonth } from '@/lib/spread';
import { USER_DATA_FORMAT_VERSION, type UserDataFile } from '@/lib/validators/user-data';

const decimalToString = (value: unknown): string => Number(value).toFixed(2);

export const exportUserData = async (userId: string): Promise<UserDataFile> => {
  const [
    user,
    accounts,
    categories,
    importBatches,
    transactions,
    budgets,
    categoryRules,
    reimbursementLinks,
    categoryAssignments,
    budgetSettings,
  ] = await Promise.all([
    prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { email: true, name: true } }),
    prisma.account.findMany({
      where: { userId },
      select: {
        id: true,
        name: true,
        type: true,
        startingBalance: true,
        statementDay: true,
        onBudget: true,
        createdAt: true,
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    }),
    prisma.category.findMany({
      where: { userId },
      select: { id: true, name: true, isDefault: true, createdAt: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    }),
    prisma.importBatch.findMany({
      where: { userId },
      select: {
        id: true,
        accountId: true,
        filename: true,
        filenameNormalized: true,
        status: true,
        rowCount: true,
        importedCount: true,
        skippedDuplicates: true,
        dateFrom: true,
        dateTo: true,
        createdAt: true,
        undoneAt: true,
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    }),
    prisma.transaction.findMany({
      where: { userId },
      select: {
        id: true,
        accountId: true,
        categoryId: true,
        amount: true,
        type: true,
        date: true,
        payee: true,
        note: true,
        importBatchId: true,
        isPayment: true,
        isTransfer: true,
        transferMatchId: true,
        isReimbursable: true,
        reimbursementExpectedAmount: true,
        reimbursementCompletedAt: true,
        spreadStartMonth: true,
        spreadMonths: true,
        skippedAt: true,
        createdAt: true,
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    }),
    // No createdAt column: ordered by id for a deterministic, if arbitrary,
    // export order (see the round-trip test's note on comparing by natural
    // key instead of position).
    prisma.budget.findMany({
      where: { userId },
      select: { id: true, categoryId: true, month: true, limitAmount: true },
      orderBy: { id: 'asc' },
    }),
    prisma.categoryRule.findMany({
      where: { userId },
      select: { id: true, categoryId: true, matchText: true, priority: true },
      orderBy: { id: 'asc' },
    }),
    prisma.reimbursementLink.findMany({
      where: { userId },
      select: {
        id: true,
        expenseTransactionId: true,
        incomeTransactionId: true,
        amount: true,
        createdAt: true,
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    }),
    prisma.categoryAssignment.findMany({
      where: { userId },
      select: { id: true, categoryId: true, month: true, amount: true },
      orderBy: [{ month: 'asc' }, { id: 'asc' }],
    }),
    prisma.userBudgetSettings.findUnique({
      where: { userId },
      select: { mode: true, zbbStartMonth: true },
    }),
  ]);

  return {
    formatVersion: USER_DATA_FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    user: { email: user.email, name: user.name },
    data: {
      accounts: accounts.map((a) => ({
        id: a.id,
        name: a.name,
        type: a.type,
        startingBalance: decimalToString(a.startingBalance),
        statementDay: a.statementDay,
        onBudget: a.onBudget,
        createdAt: a.createdAt,
      })),
      categories: categories.map((c) => ({
        id: c.id,
        name: c.name,
        isDefault: c.isDefault,
        createdAt: c.createdAt,
      })),
      importBatches: importBatches.map((b) => ({
        id: b.id,
        accountId: b.accountId,
        filename: b.filename,
        filenameNormalized: b.filenameNormalized,
        status: b.status,
        rowCount: b.rowCount,
        importedCount: b.importedCount,
        skippedDuplicates: b.skippedDuplicates,
        dateFrom: b.dateFrom,
        dateTo: b.dateTo,
        createdAt: b.createdAt,
        undoneAt: b.undoneAt,
      })),
      transactions: transactions.map((t) => ({
        id: t.id,
        accountId: t.accountId,
        categoryId: t.categoryId,
        amount: decimalToString(t.amount),
        type: t.type,
        date: t.date,
        payee: t.payee,
        note: t.note,
        importBatchId: t.importBatchId,
        isPayment: t.isPayment,
        isTransfer: t.isTransfer,
        transferMatchId: t.transferMatchId,
        isReimbursable: t.isReimbursable,
        reimbursementExpectedAmount:
          t.reimbursementExpectedAmount === null
            ? null
            : decimalToString(t.reimbursementExpectedAmount),
        reimbursementCompletedAt: t.reimbursementCompletedAt,
        spreadStartMonth: t.spreadStartMonth,
        spreadMonths: t.spreadMonths,
        skippedAt: t.skippedAt,
        createdAt: t.createdAt,
      })),
      budgets: budgets.map((b) => ({
        id: b.id,
        categoryId: b.categoryId,
        month: b.month,
        limitAmount: decimalToString(b.limitAmount),
      })),
      categoryRules: categoryRules.map((r) => ({
        id: r.id,
        categoryId: r.categoryId,
        matchText: r.matchText,
        priority: r.priority,
      })),
      reimbursementLinks: reimbursementLinks.map((l) => ({
        id: l.id,
        expenseTransactionId: l.expenseTransactionId,
        incomeTransactionId: l.incomeTransactionId,
        amount: decimalToString(l.amount),
        createdAt: l.createdAt,
      })),
      categoryAssignments: categoryAssignments.map((a) => ({
        id: a.id,
        categoryId: a.categoryId,
        month: a.month,
        amount: decimalToString(a.amount),
      })),
      budgetSettings: budgetSettings
        ? { mode: budgetSettings.mode, zbbStartMonth: budgetSettings.zbbStartMonth }
        : null,
    },
  };
};

/**
 * The ordered delete sequence shared by import's full-replace wipe and
 * account deletion (decision 5): links first (their `Restrict` FKs onto
 * `Transaction` must be gone before transactions are touched), then
 * budgets/rules (explicit rather than relying on their `Cascade` off
 * `Category`, to keep the sequence deterministic), then transactions, then
 * import batches, then categories, then accounts. `User` itself is never
 * touched here — deletion is the caller's job, one step further.
 *
 * Deliberately does not touch `NotificationPreference`/`PushSubscription`:
 * both are `onDelete: Cascade` on `userId`, so a real account deletion
 * cleans them up via `tx.user.delete()` without help, and they are not part
 * of this feature's 7-model export/import contract — wiping them as a side
 * effect of a *data* import would silently kill working push
 * registrations for no reason connected to what the user asked for.
 */
export const wipeUserData = async (tx: Prisma.TransactionClient, userId: string): Promise<void> => {
  await tx.reimbursementLink.deleteMany({ where: { userId } });
  await tx.budget.deleteMany({ where: { userId } });
  await tx.categoryAssignment.deleteMany({ where: { userId } });
  await tx.categoryRule.deleteMany({ where: { userId } });
  await tx.transaction.deleteMany({ where: { userId } });
  await tx.importBatch.deleteMany({ where: { userId } });
  await tx.category.deleteMany({ where: { userId } });
  await tx.account.deleteMany({ where: { userId } });
};

const CREATE_MANY_CHUNK_SIZE = 5000;

const chunk = <T>(items: T[], size: number): T[][] => {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
};

export type ImportUserDataResult = {
  counts: {
    accounts: number;
    categories: number;
    importBatches: number;
    transactions: number;
    budgets: number;
    categoryRules: number;
    reimbursementLinks: number;
    categoryAssignments: number;
  };
};

/**
 * Full-replace restore: assumes `file` already passed `userDataFileSchema`
 * (the route validates before calling this). Every id in the file is
 * regenerated with `randomUUID()` — see the plan's decision 1 for why — and
 * every FK is rewritten through the same map before the row is written, so
 * the restored data's internal relationships are identical even though no
 * id matches what was exported.
 */
export const importUserData = async (
  userId: string,
  file: UserDataFile,
): Promise<ImportUserDataResult> => {
  const { data } = file;

  const accountIds = new Map(data.accounts.map((a) => [a.id, randomUUID()]));
  const categoryIds = new Map(data.categories.map((c) => [c.id, randomUUID()]));
  const importBatchIds = new Map(data.importBatches.map((b) => [b.id, randomUUID()]));
  const transactionIds = new Map(data.transactions.map((t) => [t.id, randomUUID()]));
  // Its own namespace, not a copy of either leg's transaction id — see
  // decision 1: transferMatchId is an independently minted value in
  // lib/services/transfers.ts, not derived from a transaction id.
  const transferMatchIds = new Map<string, string>();
  for (const t of data.transactions) {
    if (t.transferMatchId !== null && !transferMatchIds.has(t.transferMatchId)) {
      transferMatchIds.set(t.transferMatchId, randomUUID());
    }
  }

  await prisma.$transaction(
    async (tx) => {
      await wipeUserData(tx, userId);

      for (const rows of chunk(data.accounts, CREATE_MANY_CHUNK_SIZE)) {
        await tx.account.createMany({
          data: rows.map((a) => ({
            id: accountIds.get(a.id)!,
            userId,
            name: a.name,
            type: a.type,
            startingBalance: a.startingBalance,
            statementDay: a.statementDay,
            onBudget: a.onBudget ?? defaultOnBudgetFor(a.type),
            createdAt: a.createdAt,
          })),
        });
      }

      for (const rows of chunk(data.categories, CREATE_MANY_CHUNK_SIZE)) {
        await tx.category.createMany({
          data: rows.map((c) => ({
            id: categoryIds.get(c.id)!,
            userId,
            name: c.name,
            isDefault: c.isDefault,
            createdAt: c.createdAt,
          })),
        });
      }

      for (const rows of chunk(data.importBatches, CREATE_MANY_CHUNK_SIZE)) {
        await tx.importBatch.createMany({
          data: rows.map((b) => ({
            id: importBatchIds.get(b.id)!,
            userId,
            accountId: accountIds.get(b.accountId)!,
            filename: b.filename,
            filenameNormalized: b.filenameNormalized,
            status: b.status,
            rowCount: b.rowCount,
            importedCount: b.importedCount,
            skippedDuplicates: b.skippedDuplicates,
            dateFrom: b.dateFrom,
            dateTo: b.dateTo,
            createdAt: b.createdAt,
            undoneAt: b.undoneAt,
          })),
        });
      }

      for (const rows of chunk(data.transactions, CREATE_MANY_CHUNK_SIZE)) {
        await tx.transaction.createMany({
          data: rows.map((t) => ({
            id: transactionIds.get(t.id)!,
            userId,
            accountId: accountIds.get(t.accountId)!,
            categoryId: t.categoryId === null ? null : (categoryIds.get(t.categoryId) ?? null),
            amount: t.amount,
            type: t.type,
            date: t.date,
            payee: t.payee,
            note: t.note,
            importBatchId:
              t.importBatchId === null ? null : (importBatchIds.get(t.importBatchId) ?? null),
            isPayment: t.isPayment,
            isTransfer: t.isTransfer,
            transferMatchId:
              t.transferMatchId === null ? null : (transferMatchIds.get(t.transferMatchId) ?? null),
            isReimbursable: t.isReimbursable,
            reimbursementExpectedAmount: t.reimbursementExpectedAmount,
            reimbursementCompletedAt: t.reimbursementCompletedAt,
            spreadStartMonth: t.spreadMonths == null ? null : (t.spreadStartMonth ?? null),
            spreadMonths: t.spreadStartMonth == null ? null : (t.spreadMonths ?? null),
            spreadEndMonth:
              t.spreadStartMonth == null || t.spreadMonths == null
                ? null
                : spreadEndMonth(t.spreadStartMonth, t.spreadMonths),
            skippedAt: t.skippedAt,
            createdAt: t.createdAt,
          })),
        });
      }

      for (const rows of chunk(data.budgets, CREATE_MANY_CHUNK_SIZE)) {
        await tx.budget.createMany({
          data: rows.map((b) => ({
            id: randomUUID(),
            userId,
            categoryId: categoryIds.get(b.categoryId)!,
            month: b.month,
            limitAmount: b.limitAmount,
          })),
        });
      }

      for (const rows of chunk(data.categoryRules, CREATE_MANY_CHUNK_SIZE)) {
        await tx.categoryRule.createMany({
          data: rows.map((r) => ({
            id: randomUUID(),
            userId,
            categoryId: categoryIds.get(r.categoryId)!,
            matchText: r.matchText,
            priority: r.priority,
          })),
        });
      }

      for (const rows of chunk(data.reimbursementLinks, CREATE_MANY_CHUNK_SIZE)) {
        await tx.reimbursementLink.createMany({
          data: rows.map((l) => ({
            id: randomUUID(),
            userId,
            expenseTransactionId: transactionIds.get(l.expenseTransactionId)!,
            incomeTransactionId: transactionIds.get(l.incomeTransactionId)!,
            amount: l.amount,
            createdAt: l.createdAt,
          })),
        });
      }

      for (const rows of chunk(data.categoryAssignments ?? [], CREATE_MANY_CHUNK_SIZE)) {
        await tx.categoryAssignment.createMany({
          data: rows.map((a) => ({
            id: randomUUID(),
            userId,
            categoryId: categoryIds.get(a.categoryId)!,
            month: a.month,
            amount: a.amount,
          })),
        });
      }

      // a v1 file says nothing about the budgeting mode, so the current one
      // stays; a v2 file carries it (null = never changed, i.e. LIMITS)
      if (data.budgetSettings !== undefined) {
        await tx.userBudgetSettings.deleteMany({ where: { userId } });
        if (data.budgetSettings !== null) {
          await tx.userBudgetSettings.create({ data: { userId, ...data.budgetSettings } });
        }
      }
    },
    { timeout: 60_000, maxWait: 10_000 },
  );

  return {
    counts: {
      accounts: data.accounts.length,
      categories: data.categories.length,
      importBatches: data.importBatches.length,
      transactions: data.transactions.length,
      budgets: data.budgets.length,
      categoryRules: data.categoryRules.length,
      reimbursementLinks: data.reimbursementLinks.length,
      categoryAssignments: data.categoryAssignments?.length ?? 0,
    },
  };
};
