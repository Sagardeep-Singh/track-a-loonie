import {
  balanceChange,
  historyMonths,
  trackedAccountMonthlyBalances,
  transactionAccountMonthlyBalances,
  type BalanceChange,
  type HistoryRange,
} from '@/lib/account-history';
import { monthOfDate, monthRange } from '@/lib/date';
import { prisma } from '@/lib/db/prisma';
import { ServiceValidationError } from '@/lib/services/common';
import type { CreateBalanceUpdateInput } from '@/lib/validators/accounts';

export type FrontendBalanceUpdate = {
  id: string;
  balance: string;
  date: string;
  note: string | null;
  /** difference from the update before it; null for the first one (and on create) */
  change: string | null;
};

export type HistoryPoint = { month: number; label: string; balance: number | null };

export type AccountHistory = {
  range: HistoryRange;
  points: HistoryPoint[];
  change: BalanceChange | null;
  /** newest first; empty for transaction accounts */
  updates: FrontendBalanceUpdate[];
};

export type NetWorthHistory = {
  range: HistoryRange;
  points: HistoryPoint[];
  change: BalanceChange | null;
};

const MONTH_LABEL = new Intl.DateTimeFormat('en-US', {
  timeZone: 'UTC',
  month: 'short',
  year: '2-digit',
});

const toPoints = (months: number[], balances: (number | null)[]): HistoryPoint[] =>
  months.map((month, i) => ({
    month,
    label: MONTH_LABEL.format(monthRange(month).start),
    balance: balances[i] ?? null,
  }));

const toCents = (value: unknown): number => Math.round(Number(value) * 100);

const toFrontendUpdate = (
  update: { id: string; balance: unknown; date: Date; note: string | null },
  previous?: { balance: unknown },
): FrontendBalanceUpdate => ({
  id: update.id,
  balance: Number(update.balance).toFixed(2),
  date: update.date.toISOString(),
  note: update.note,
  change: previous
    ? ((toCents(update.balance) - toCents(previous.balance)) / 100).toFixed(2)
    : null,
});

const updateOrder = [{ date: 'desc' as const }, { createdAt: 'desc' as const }];

export const createBalanceUpdate = async (
  userId: string,
  accountId: string,
  input: CreateBalanceUpdateInput,
): Promise<FrontendBalanceUpdate> => {
  const account = await prisma.account.findFirst({
    where: { id: accountId, userId },
    select: { tracksBalance: true },
  });
  if (!account) {
    throw new ServiceValidationError('Account not found');
  }
  if (!account.tracksBalance) {
    throw new ServiceValidationError(
      'This account’s balance comes from its transactions. Turn on balance tracking to log updates.',
    );
  }

  const update = await prisma.accountBalanceUpdate.create({
    data: {
      userId,
      accountId,
      balance: input.balance,
      date: input.date,
      note: input.note || null,
    },
  });
  return toFrontendUpdate(update);
};

export const deleteBalanceUpdate = async (
  userId: string,
  accountId: string,
  updateId: string,
): Promise<void> => {
  const { count } = await prisma.accountBalanceUpdate.deleteMany({
    where: { id: updateId, accountId, userId },
  });
  if (count === 0) {
    throw new ServiceValidationError('Balance update not found');
  }
};

/**
 * Month-end balances of one account over the `range` months ending this
 * month, plus its balance update log when it's tracked by balance.
 */
export const getAccountHistory = async (
  userId: string,
  accountId: string,
  range: HistoryRange,
  now: Date = new Date(),
): Promise<AccountHistory> => {
  const account = await prisma.account.findFirst({
    where: { id: accountId, userId },
    select: {
      startingBalance: true,
      createdAt: true,
      tracksBalance: true,
      transactions: { select: { amount: true, type: true, date: true } },
      balanceUpdates: {
        orderBy: updateOrder,
        select: { id: true, balance: true, date: true, note: true, createdAt: true },
      },
    },
  });
  if (!account) {
    throw new ServiceValidationError('Account not found');
  }

  const months = historyMonths(monthOfDate(now), range);
  const balances = account.tracksBalance
    ? trackedAccountMonthlyBalances(account.balanceUpdates, months)
    : transactionAccountMonthlyBalances(account, account.transactions, months);

  return {
    range,
    points: toPoints(months, balances),
    change: balanceChange(balances),
    // newest first, so the update before each one is the next in the list
    updates: account.tracksBalance
      ? account.balanceUpdates.map((u, i) => toFrontendUpdate(u, account.balanceUpdates[i + 1]))
      : [],
  };
};

/**
 * Net worth at each month end: every account's month-end balance summed, an
 * account counting as 0 in months before it had any data. Liabilities carry
 * their (negative) signed balance, same as the Accounts page total.
 */
export const getNetWorthHistory = async (
  userId: string,
  range: HistoryRange,
  now: Date = new Date(),
): Promise<NetWorthHistory> => {
  const accounts = await prisma.account.findMany({
    where: { userId },
    select: {
      startingBalance: true,
      createdAt: true,
      tracksBalance: true,
      transactions: { select: { amount: true, type: true, date: true } },
      balanceUpdates: { select: { balance: true, date: true, createdAt: true } },
    },
  });

  const months = historyMonths(monthOfDate(now), range);
  const totalsCents = months.map(() => 0);
  const anyData = months.map(() => false);
  for (const account of accounts) {
    const balances = account.tracksBalance
      ? trackedAccountMonthlyBalances(account.balanceUpdates, months)
      : transactionAccountMonthlyBalances(account, account.transactions, months);
    balances.forEach((balance, i) => {
      if (balance === null) return;
      totalsCents[i] += Math.round(balance * 100);
      anyData[i] = true;
    });
  }

  const balances = totalsCents.map((cents, i) => (anyData[i] ? cents / 100 : null));
  return { range, points: toPoints(months, balances), change: balanceChange(balances) };
};
