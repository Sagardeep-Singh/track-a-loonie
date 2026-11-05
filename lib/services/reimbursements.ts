import { prisma } from '@/lib/db/prisma';
import { ServiceValidationError, ReimbursementConflictError } from '@/lib/services/common';
import { compileRuleMatcher } from '@/lib/services/categorize';
import { assertFeature } from '@/lib/services/entitlements';
import type {
  CreateReimbursementLinkInput,
  UpdateReimbursementLinkInput,
} from '@/lib/validators/reimbursements';

export type ReimbursementStatus = 'PENDING' | 'PARTIAL' | 'COMPLETE';

export type FrontendReimbursementLink = {
  id: string;
  expenseTransactionId: string;
  incomeTransactionId: string;
  amount: string;
  createdAt: string;
  incomeDate: string;
  incomeAmount: string;
  incomePayee: string | null;
  incomeAccountId: string;
  incomeAccountName: string;
};

export type FrontendExpenseReimbursement = {
  expenseTransactionId: string;
  expenseAmount: string;
  isReimbursable: boolean;
  expectedAmount: string | null;
  linkedTotal: string;
  outstanding: string;
  overshoot: string;
  status: ReimbursementStatus | null;
  completedManually: boolean;
  completedAt: string | null;
  links: FrontendReimbursementLink[];
};

export type ReimbursementCandidate = {
  transactionId: string;
  date: string;
  amount: string;
  availableAmount: string;
  payee: string | null;
  accountId: string;
  accountName: string;
  categoryId: string | null;
  categoryName: string | null;
  suggestedAmount: string;
  score: number;
  reasons: string[];
};

export type FrontendReimbursementPendingSummary = {
  pendingTotal: string;
  pendingCount: number;
};

/** Money is a Decimal in Prisma — never compare two of them with `===`. */
export const toCents = (value: unknown): number => Math.round(Number(value) * 100);

export const fromCents = (cents: number): string => (cents / 100).toFixed(2);

export const deriveReimbursementStatus = (args: {
  isReimbursable: boolean;
  expectedCents: number | null;
  linkedCents: number;
  completedAt: Date | null;
}): ReimbursementStatus | null => {
  if (!args.isReimbursable) return null;
  if (args.completedAt !== null) return 'COMPLETE';
  if (args.expectedCents !== null && args.linkedCents >= args.expectedCents) return 'COMPLETE';
  if (args.linkedCents > 0) return 'PARTIAL';
  return 'PENDING';
};

type ExpenseRow = {
  id: string;
  amount: unknown;
  isReimbursable: boolean;
  reimbursementExpectedAmount: unknown;
  reimbursementCompletedAt: Date | null;
  reimbursementExpenseLinks: {
    id: string;
    incomeTransactionId: string;
    amount: unknown;
    createdAt: Date;
    income: {
      id: string;
      date: Date;
      amount: unknown;
      payee: string | null;
      accountId: string;
      account: { name: string };
    };
  }[];
};

const toExpenseReimbursement = (expense: ExpenseRow): FrontendExpenseReimbursement => {
  const expectedCents =
    expense.reimbursementExpectedAmount == null
      ? null
      : toCents(expense.reimbursementExpectedAmount);
  const linkedCents = expense.reimbursementExpenseLinks.reduce(
    (sum, link) => sum + toCents(link.amount),
    0,
  );
  const status = deriveReimbursementStatus({
    isReimbursable: expense.isReimbursable,
    expectedCents,
    linkedCents,
    completedAt: expense.reimbursementCompletedAt,
  });
  const outstandingCents = expectedCents === null ? 0 : Math.max(0, expectedCents - linkedCents);
  const overshootCents = expectedCents === null ? 0 : Math.max(0, linkedCents - expectedCents);

  return {
    expenseTransactionId: expense.id,
    expenseAmount: fromCents(toCents(expense.amount)),
    isReimbursable: expense.isReimbursable,
    expectedAmount: expectedCents === null ? null : fromCents(expectedCents),
    linkedTotal: fromCents(linkedCents),
    outstanding: fromCents(outstandingCents),
    overshoot: fromCents(overshootCents),
    status,
    completedManually: expense.reimbursementCompletedAt !== null,
    completedAt: expense.reimbursementCompletedAt?.toISOString() ?? null,
    links: [...expense.reimbursementExpenseLinks]
      .sort(
        (a, b) =>
          a.income.date.getTime() - b.income.date.getTime() ||
          a.createdAt.getTime() - b.createdAt.getTime(),
      )
      .map((link) => ({
        id: link.id,
        expenseTransactionId: expense.id,
        incomeTransactionId: link.incomeTransactionId,
        amount: fromCents(toCents(link.amount)),
        createdAt: link.createdAt.toISOString(),
        incomeDate: link.income.date.toISOString(),
        incomeAmount: fromCents(toCents(link.income.amount)),
        incomePayee: link.income.payee,
        incomeAccountId: link.income.accountId,
        incomeAccountName: link.income.account.name,
      })),
  };
};

const expenseInclude = {
  reimbursementExpenseLinks: {
    include: { income: { include: { account: { select: { name: true } } } } },
  },
} as const;

export const getExpenseReimbursement = async (
  userId: string,
  expenseTransactionId: string,
): Promise<FrontendExpenseReimbursement> => {
  const expense = await prisma.transaction.findFirst({
    where: { id: expenseTransactionId, userId },
    include: expenseInclude,
  });
  if (!expense) {
    throw new ServiceValidationError('Transaction not found');
  }
  return toExpenseReimbursement(expense);
};

const CANDIDATE_POOL_CAP = 200;
const DEFAULT_CANDIDATE_LIMIT = 8;
/** amount-closeness scoring weight vs. date-proximity weight */
const AMOUNT_SCORE_WEIGHT = 0.6;
const DATE_SCORE_WEIGHT = 0.4;
const PAYEE_BONUS = 0.2;
const CATEGORY_BONUS = 0.15;
const DATE_DECAY_DAYS = 45;
const DATE_FAR_DAYS = 120;

/** One search word must match payee, note, account or category (case-insensitive), or the amount when numeric. */
const buildSearchClause = (token: string): Record<string, unknown> => {
  const contains = { contains: token, mode: 'insensitive' as const };
  const amount = Number(token.replace(/^\$/, '').replace(/,/g, ''));
  return {
    OR: [
      { payee: contains },
      { note: contains },
      { account: { name: contains } },
      { category: { name: contains } },
      ...(Number.isFinite(amount) && amount > 0 ? [{ amount }] : []),
    ],
  };
};

export const listReimbursementCandidates = async (
  userId: string,
  expenseTransactionId: string,
  options: { limit?: number; search?: string } = {},
): Promise<ReimbursementCandidate[]> => {
  await assertFeature(userId, 'reimbursements');
  const expense = await prisma.transaction.findFirst({
    where: { id: expenseTransactionId, userId },
    include: expenseInclude,
  });
  if (!expense) {
    throw new ServiceValidationError('Transaction not found');
  }
  const summary = toExpenseReimbursement(expense);
  const outstandingCents = Math.max(1, toCents(summary.outstanding));

  const searchTokens = (options.search ?? '').trim().split(/\s+/).filter(Boolean);

  const pool = await prisma.transaction.findMany({
    where: {
      userId,
      type: 'INCOME',
      isTransfer: false,
      isPayment: false,
      ...(options.search ? {} : { date: { gte: expense.date } }),
      reimbursementIncomeLinks: { none: { expenseTransactionId } },
      ...(searchTokens.length > 0 ? { AND: searchTokens.map(buildSearchClause) } : {}),
    },
    include: {
      account: { select: { name: true } },
      category: { select: { name: true } },
      reimbursementIncomeLinks: { select: { amount: true } },
    },
    // a search can match far more than the pool cap, so keep the most recent
    orderBy: { date: searchTokens.length > 0 ? 'desc' : 'asc' },
    take: CANDIDATE_POOL_CAP,
  });

  const haystack = `${expense.payee ?? ''} ${expense.note ?? ''}`.trim();
  const tokens = haystack
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length >= 4);

  const candidates = pool
    .map((income) => {
      const amountCents = toCents(income.amount);
      const allocatedCents = income.reimbursementIncomeLinks.reduce(
        (sum, l) => sum + toCents(l.amount),
        0,
      );
      const availableCents = amountCents - allocatedCents;
      if (availableCents <= 0) return null;

      const delta = Math.abs(availableCents - outstandingCents);
      const amountScore =
        delta === 0
          ? 1
          : delta <= Math.max(100, outstandingCents * 0.01)
            ? 0.85
            : availableCents >= outstandingCents
              ? 0.6
              : 0.4 * (availableCents / outstandingCents);

      const days = (income.date.getTime() - expense.date.getTime()) / 86_400_000;
      const dateScore =
        days <= DATE_DECAY_DAYS
          ? Math.max(0, 1 - Math.abs(days) / 60)
          : days <= DATE_FAR_DAYS
            ? 0.15
            : 0.05;

      const payeeMatches = tokens.some((t) => compileRuleMatcher(t).test(income.payee ?? ''));
      const payeeBonus = payeeMatches ? PAYEE_BONUS : 0;

      const categoryMatches =
        expense.categoryId !== null && income.categoryId === expense.categoryId;
      const categoryBonus = categoryMatches ? CATEGORY_BONUS : 0;

      const score = Math.min(
        1,
        AMOUNT_SCORE_WEIGHT * amountScore +
          DATE_SCORE_WEIGHT * dateScore +
          payeeBonus +
          categoryBonus,
      );

      const reasons: string[] = [];
      if (delta === 0)
        reasons.push(`Exact match for the ${fromCents(outstandingCents)} outstanding`);
      else if (amountScore >= 0.85) reasons.push('Amount is very close to what is outstanding');
      if (days >= 0 && days <= DATE_DECAY_DAYS)
        reasons.push(`${Math.round(days)} days after the expense`);
      if (payeeMatches) reasons.push('Payee matches the expense');
      if (categoryMatches) reasons.push(`Same category (${income.category?.name ?? 'Unknown'})`);
      if (reasons.length === 0) reasons.push('Possible match');

      const suggestedAmount = Math.min(availableCents, outstandingCents);

      return {
        transactionId: income.id,
        date: income.date.toISOString(),
        amount: fromCents(amountCents),
        availableAmount: fromCents(availableCents),
        payee: income.payee,
        accountId: income.accountId,
        accountName: income.account.name,
        categoryId: income.categoryId,
        categoryName: income.category?.name ?? null,
        suggestedAmount: fromCents(suggestedAmount),
        score,
        reasons,
      };
    })
    .filter((c): c is NonNullable<typeof c> => c !== null)
    .sort(
      (a, b) =>
        b.score - a.score ||
        Math.abs(toCents(a.availableAmount) - outstandingCents) -
          Math.abs(toCents(b.availableAmount) - outstandingCents) ||
        a.date.localeCompare(b.date),
    );

  return candidates.slice(0, options.limit ?? DEFAULT_CANDIDATE_LIMIT);
};

/** Ids of PENDING/PARTIAL reimbursable expenses. Status is derived, so Prisma can't filter on it. */
export const listPendingReimbursementExpenseIds = async (userId: string): Promise<string[]> => {
  const expenses = await prisma.transaction.findMany({
    where: { userId, isReimbursable: true, reimbursementCompletedAt: null },
    select: {
      id: true,
      reimbursementExpectedAmount: true,
      reimbursementExpenseLinks: { select: { amount: true } },
    },
  });
  return expenses
    .filter((expense) => {
      const status = deriveReimbursementStatus({
        isReimbursable: true,
        expectedCents:
          expense.reimbursementExpectedAmount == null
            ? null
            : toCents(expense.reimbursementExpectedAmount),
        linkedCents: expense.reimbursementExpenseLinks.reduce(
          (sum, l) => sum + toCents(l.amount),
          0,
        ),
        completedAt: null,
      });
      return status === 'PENDING' || status === 'PARTIAL';
    })
    .map((expense) => expense.id);
};

export const getPendingReimbursementSummary = async (
  userId: string,
): Promise<FrontendReimbursementPendingSummary> => {
  const expenses = await prisma.transaction.findMany({
    where: { userId, isReimbursable: true, reimbursementCompletedAt: null },
    select: { id: true, reimbursementExpectedAmount: true },
  });
  if (expenses.length === 0) {
    return { pendingTotal: '0.00', pendingCount: 0 };
  }

  const links = await prisma.reimbursementLink.groupBy({
    by: ['expenseTransactionId'],
    where: { userId, expenseTransactionId: { in: expenses.map((e) => e.id) } },
    _sum: { amount: true },
  });
  const linkedByExpense = new Map(
    links.map((l) => [l.expenseTransactionId, toCents(l._sum.amount ?? 0)]),
  );

  let pendingTotalCents = 0;
  let pendingCount = 0;
  for (const expense of expenses) {
    const expectedCents = toCents(expense.reimbursementExpectedAmount ?? 0);
    const linkedCents = linkedByExpense.get(expense.id) ?? 0;
    const outstandingCents = Math.max(0, expectedCents - linkedCents);
    if (outstandingCents > 0) {
      pendingTotalCents += outstandingCents;
      pendingCount += 1;
    }
  }

  return { pendingTotal: fromCents(pendingTotalCents), pendingCount };
};

const assertLinkable = async (
  userId: string,
  expenseTransactionId: string,
  incomeTransactionId: string,
): Promise<{ expenseAmountCents: number; incomeAmountCents: number }> => {
  if (expenseTransactionId === incomeTransactionId) {
    throw new ServiceValidationError('A transaction cannot reimburse itself');
  }
  const rows = await prisma.transaction.findMany({
    where: { userId, id: { in: [expenseTransactionId, incomeTransactionId] } },
    select: {
      id: true,
      type: true,
      amount: true,
      isReimbursable: true,
      isTransfer: true,
      isPayment: true,
    },
  });
  const expense = rows.find((r) => r.id === expenseTransactionId);
  const income = rows.find((r) => r.id === incomeTransactionId);
  if (!expense || !income) {
    throw new ServiceValidationError('Transaction not found');
  }
  if (expense.type !== 'EXPENSE' || !expense.isReimbursable) {
    throw new ServiceValidationError(
      'Mark this expense as reimbursable before linking income to it',
    );
  }
  if (expense.isTransfer || expense.isPayment) {
    throw new ServiceValidationError('This expense cannot be linked to a reimbursement');
  }
  if (income.type !== 'INCOME') {
    throw new ServiceValidationError('Only an income transaction can reimburse an expense');
  }
  if (income.isTransfer || income.isPayment) {
    throw new ServiceValidationError(
      'This income is a transfer or card payment and cannot be linked as a reimbursement',
    );
  }
  return { expenseAmountCents: toCents(expense.amount), incomeAmountCents: toCents(income.amount) };
};

export const createReimbursementLink = async (
  userId: string,
  input: CreateReimbursementLinkInput,
): Promise<FrontendExpenseReimbursement> => {
  const { expenseTransactionId, incomeTransactionId, amount } = input;
  await assertFeature(userId, 'reimbursements');
  await assertLinkable(userId, expenseTransactionId, incomeTransactionId);
  const amountCents = toCents(amount);

  await prisma.$transaction(async (tx) => {
    const otherLinks = await tx.reimbursementLink.findMany({
      where: { incomeTransactionId, NOT: { expenseTransactionId } },
      select: { amount: true },
    });
    const income = await tx.transaction.findFirstOrThrow({
      where: { id: incomeTransactionId, userId },
      select: { amount: true },
    });
    const allocatedCents = otherLinks.reduce((sum, l) => sum + toCents(l.amount), 0);
    const availableCents = toCents(income.amount) - allocatedCents;
    if (amountCents > availableCents) {
      throw new ReimbursementConflictError(
        `This income only has ${fromCents(Math.max(0, availableCents))} left to allocate`,
      );
    }

    await tx.reimbursementLink.upsert({
      where: {
        expenseTransactionId_incomeTransactionId: { expenseTransactionId, incomeTransactionId },
      },
      create: { userId, expenseTransactionId, incomeTransactionId, amount },
      update: { amount },
    });
  });

  return getExpenseReimbursement(userId, expenseTransactionId);
};

export const updateReimbursementLink = async (
  userId: string,
  linkId: string,
  input: UpdateReimbursementLinkInput,
): Promise<FrontendExpenseReimbursement> => {
  await assertFeature(userId, 'reimbursements');
  const link = await prisma.reimbursementLink.findFirst({
    where: { id: linkId, userId },
    select: { expenseTransactionId: true, incomeTransactionId: true },
  });
  if (!link) {
    throw new ServiceValidationError('Reimbursement link not found');
  }
  const amountCents = toCents(input.amount);

  await prisma.$transaction(async (tx) => {
    const otherLinks = await tx.reimbursementLink.findMany({
      where: { incomeTransactionId: link.incomeTransactionId, NOT: { id: linkId } },
      select: { amount: true },
    });
    const income = await tx.transaction.findFirstOrThrow({
      where: { id: link.incomeTransactionId, userId },
      select: { amount: true },
    });
    const allocatedCents = otherLinks.reduce((sum, l) => sum + toCents(l.amount), 0);
    const availableCents = toCents(income.amount) - allocatedCents;
    if (amountCents > availableCents) {
      throw new ReimbursementConflictError(
        `This income only has ${fromCents(Math.max(0, availableCents))} left to allocate`,
      );
    }
    await tx.reimbursementLink.update({ where: { id: linkId }, data: { amount: input.amount } });
  });

  return getExpenseReimbursement(userId, link.expenseTransactionId);
};

export const deleteReimbursementLink = async (
  userId: string,
  linkId: string,
): Promise<FrontendExpenseReimbursement> => {
  const link = await prisma.reimbursementLink.findFirst({
    where: { id: linkId, userId },
    select: { expenseTransactionId: true },
  });
  if (!link) {
    throw new ServiceValidationError('Reimbursement link not found');
  }
  await prisma.reimbursementLink.delete({ where: { id: linkId } });
  return getExpenseReimbursement(userId, link.expenseTransactionId);
};

/** cents, keyed by expense transaction id */
export const getLinkedCentsByExpense = async (
  userId: string,
  expenseIds: string[],
): Promise<Map<string, number>> => {
  if (expenseIds.length === 0) return new Map();
  const rows = await prisma.reimbursementLink.groupBy({
    by: ['expenseTransactionId'],
    where: { userId, expenseTransactionId: { in: expenseIds } },
    _sum: { amount: true },
  });
  return new Map(rows.map((r) => [r.expenseTransactionId, toCents(r._sum.amount ?? 0)]));
};

/** cents, keyed by income transaction id */
export const getLinkedCentsByIncome = async (
  userId: string,
  incomeIds: string[],
): Promise<Map<string, number>> => {
  if (incomeIds.length === 0) return new Map();
  const rows = await prisma.reimbursementLink.groupBy({
    by: ['incomeTransactionId'],
    where: { userId, incomeTransactionId: { in: incomeIds } },
    _sum: { amount: true },
  });
  return new Map(rows.map((r) => [r.incomeTransactionId, toCents(r._sum.amount ?? 0)]));
};

/** throws ReimbursementConflictError when any of these ids appears on either side of an active link */
export const assertNoActiveLinks = async (
  userId: string,
  transactionIds: string[],
  message: string,
): Promise<void> => {
  if (transactionIds.length === 0) return;
  const count = await prisma.reimbursementLink.count({
    where: {
      userId,
      OR: [
        { expenseTransactionId: { in: transactionIds } },
        { incomeTransactionId: { in: transactionIds } },
      ],
    },
  });
  if (count > 0) {
    throw new ReimbursementConflictError(message);
  }
};

export type ReimbursedExpenseRow = {
  expenseTransactionId: string;
  categoryId: string | null;
  expenseDate: string;
  amount: string;
};

/** reimbursed amounts for EXPENSES falling in [start, end) — the net-out source for
 * budgets/overview/trends. One row per link, plus a top-up row for an expense the user
 * manually marked fully reimbursed, covering whatever of its expected amount isn't linked. */
export const listReimbursedAmountsByExpenseDate = async (
  userId: string,
  start: Date,
  end: Date,
): Promise<ReimbursedExpenseRow[]> => {
  const [rows, manuallyCompleted] = await Promise.all([
    prisma.reimbursementLink.findMany({
      where: {
        userId,
        expense: { type: 'EXPENSE', isTransfer: false, date: { gte: start, lt: end } },
      },
      select: {
        amount: true,
        expenseTransactionId: true,
        expense: { select: { categoryId: true, date: true } },
      },
    }),
    prisma.transaction.findMany({
      where: {
        userId,
        type: 'EXPENSE',
        isTransfer: false,
        isReimbursable: true,
        reimbursementCompletedAt: { not: null },
        date: { gte: start, lt: end },
      },
      select: {
        id: true,
        categoryId: true,
        date: true,
        reimbursementExpectedAmount: true,
        reimbursementExpenseLinks: { select: { amount: true } },
      },
    }),
  ]);
  const linkRows = rows.map((r) => ({
    expenseTransactionId: r.expenseTransactionId,
    categoryId: r.expense.categoryId,
    expenseDate: r.expense.date.toISOString(),
    amount: fromCents(toCents(r.amount)),
  }));
  const topUpRows = manuallyCompleted.flatMap((t) => {
    const linkedCents = t.reimbursementExpenseLinks.reduce((sum, l) => sum + toCents(l.amount), 0);
    const remainingCents = toCents(t.reimbursementExpectedAmount) - linkedCents;
    return remainingCents > 0
      ? [
          {
            expenseTransactionId: t.id,
            categoryId: t.categoryId,
            expenseDate: t.date.toISOString(),
            amount: fromCents(remainingCents),
          },
        ]
      : [];
  });
  return [...linkRows, ...topUpRows];
};
