import { defaultOnBudgetFor, defaultTracksBalanceFor } from '@/lib/account-types';
import { fromDateKey, toDateKey } from '@/lib/date';
import { prisma } from '@/lib/db/prisma';
import { toSerializable } from '@/lib/utils';
import { ServiceValidationError } from '@/lib/services/common';
import { assertNoActiveLinks } from '@/lib/services/reimbursements';
import type { CreateAccountInput, UpdateAccountInput } from '@/lib/validators/accounts';

export type FrontendAccount = {
  id: string;
  name: string;
  type: string;
  startingBalance: string;
  balance: string;
  createdAt: string;
  statementDay: number | null;
  /** zero-based budgeting only: whether the balance feeds Ready to Assign */
  onBudget: boolean;
  /** balance comes from logged balance updates; never holds transactions */
  tracksBalance: boolean;
  /** date of the update the balance comes from; null for transaction accounts */
  balanceUpdatedAt: string | null;
  transactionCount: number;
  lastImportAt: string | null;
};

const accountInclude = {
  transactions: { select: { amount: true, type: true } },
  importBatches: { where: { status: 'ACTIVE' as const }, select: { createdAt: true } },
  // only the latest one: it is the balance of a tracked account
  balanceUpdates: {
    orderBy: [{ date: 'desc' as const }, { createdAt: 'desc' as const }],
    take: 1,
    select: { balance: true, date: true },
  },
};

const toFrontendAccount = (account: {
  id: string;
  name: string;
  type: string;
  startingBalance: unknown;
  createdAt: Date;
  statementDay: number | null;
  onBudget: boolean;
  tracksBalance: boolean;
  transactions: { amount: unknown; type: string }[];
  importBatches: { createdAt: Date }[];
  balanceUpdates?: { balance: unknown; date: Date }[];
}): FrontendAccount => {
  const starting = Number(account.startingBalance);
  const net = account.transactions.reduce((sum, t) => {
    const amount = Number(t.amount);
    return sum + (t.type === 'INCOME' ? amount : -amount);
  }, 0);
  const latestUpdate = account.tracksBalance ? account.balanceUpdates?.[0] : undefined;
  const lastImportAt = account.importBatches.reduce<Date | null>(
    (latest, b) => (!latest || b.createdAt > latest ? b.createdAt : latest),
    null,
  );

  return {
    id: account.id,
    name: account.name,
    type: account.type,
    startingBalance: toSerializable(account.startingBalance) as string,
    createdAt: account.createdAt.toISOString(),
    balance: (latestUpdate ? Number(latestUpdate.balance) : starting + net).toFixed(2),
    statementDay: account.statementDay,
    onBudget: account.onBudget,
    tracksBalance: account.tracksBalance,
    balanceUpdatedAt: latestUpdate?.date.toISOString() ?? null,
    transactionCount: account.transactions.length,
    lastImportAt: lastImportAt?.toISOString() ?? null,
  };
};

export const listAccounts = async (userId: string): Promise<FrontendAccount[]> => {
  const accounts = await prisma.account.findMany({
    where: { userId },
    include: accountInclude,
    orderBy: { createdAt: 'asc' },
  });
  return accounts.map(toFrontendAccount);
};

export const getAccount = async (userId: string, accountId: string): Promise<FrontendAccount> => {
  const account = await prisma.account.findFirst({
    where: { id: accountId, userId },
    include: accountInclude,
  });
  if (!account) {
    throw new ServiceValidationError('Account not found');
  }
  return toFrontendAccount(account);
};

/** UTC midnight of today, for a first balance update the client didn't date. */
const todayUtc = (): Date => fromDateKey(toDateKey(new Date()))!;

const TRACKED_ON_BUDGET_MESSAGE = 'A balance-tracked account is always off-budget';

export const createAccount = async (
  userId: string,
  input: CreateAccountInput,
): Promise<FrontendAccount> => {
  const tracksBalance = input.tracksBalance ?? defaultTracksBalanceFor(input.type);
  const account = await prisma.account.create({
    data: {
      userId,
      name: input.name,
      type: input.type,
      startingBalance: input.startingBalance,
      statementDay: input.type === 'CREDIT_CARD' ? (input.statementDay ?? null) : null,
      // savings and investments are long-term money: off-budget unless the
      // user says otherwise. A tracked balance moves without transactions, so
      // it can never feed Ready to Assign.
      onBudget: tracksBalance ? false : (input.onBudget ?? defaultOnBudgetFor(input.type)),
      tracksBalance,
      // the starting balance is the first point of the account's history
      ...(tracksBalance && {
        balanceUpdates: {
          create: {
            userId,
            balance: input.startingBalance,
            date: input.startingBalanceDate ?? todayUtc(),
          },
        },
      }),
    },
    include: accountInclude,
  });
  return toFrontendAccount(account);
};

export const updateAccount = async (
  userId: string,
  accountId: string,
  input: UpdateAccountInput,
): Promise<FrontendAccount> => {
  const existing = await prisma.account.findFirst({
    where: { id: accountId, userId },
    include: {
      _count: { select: { transactions: true, balanceUpdates: true } },
      balanceUpdates: accountInclude.balanceUpdates,
    },
  });
  if (!existing) {
    throw new ServiceValidationError('Account not found');
  }

  const nextType = input.type ?? existing.type;
  if (nextType !== 'CREDIT_CARD' && input.statementDay) {
    throw new ServiceValidationError('statementDay only applies to credit card accounts');
  }

  const { startingBalanceDate, ...fields } = input;
  const tracksBalance = input.tracksBalance ?? existing.tracksBalance;
  const startsTracking = tracksBalance && !existing.tracksBalance;
  const stopsTracking = !tracksBalance && existing.tracksBalance;
  if (tracksBalance && input.onBudget) {
    throw new ServiceValidationError(TRACKED_ON_BUDGET_MESSAGE);
  }
  if (startsTracking && existing._count.transactions > 0) {
    throw new ServiceValidationError(
      'Move or delete this account’s transactions before tracking it by balance updates',
    );
  }

  const latestUpdate = existing.balanceUpdates[0];
  const account = await prisma.account.update({
    where: { id: accountId },
    data: {
      ...fields,
      statementDay: nextType === 'CREDIT_CARD' ? input.statementDay : input.type ? null : undefined,
      ...(tracksBalance && { onBudget: false }),
      // keep the balance where it was: the transaction math starts from here
      ...(stopsTracking &&
        input.startingBalance === undefined &&
        latestUpdate && { startingBalance: latestUpdate.balance }),
      // first time tracking: the current balance is the history's first point.
      // Re-enabling keeps the updates logged before.
      ...(startsTracking &&
        existing._count.balanceUpdates === 0 && {
          balanceUpdates: {
            create: {
              userId,
              balance: input.startingBalance ?? existing.startingBalance,
              date: startingBalanceDate ?? todayUtc(),
            },
          },
        }),
    },
    include: accountInclude,
  });
  return toFrontendAccount(account);
};

export const deleteAccount = async (userId: string, accountId: string): Promise<void> => {
  const existing = await prisma.account.findFirst({
    where: { id: accountId, userId },
    include: { transactions: { select: { id: true } } },
  });
  if (!existing) {
    throw new ServiceValidationError('Account not found');
  }
  // Reimbursement links are cross-account by design, so deleting this account
  // could otherwise silently orphan a link on another account's expense —
  // same "blocked, not cascaded" rule as deleting a linked transaction directly.
  await assertNoActiveLinks(
    userId,
    existing.transactions.map((t) => t.id),
    'This account has transactions linked to reimbursements. Remove those links before deleting it.',
  );
  await prisma.account.delete({ where: { id: accountId } });
};
