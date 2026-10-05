import { randomUUID } from 'crypto';
import { prisma } from '@/lib/db/prisma';

/**
 * How far apart the two legs of one transfer may post. Bank and card postings
 * for the same payment routinely land 1-3 days apart; 5 days absorbs a weekend
 * plus a holiday without reaching far enough to collide with the next month's
 * identically-sized payment.
 */
const MATCH_WINDOW_DAYS = 5;
const MATCH_WINDOW_MS = MATCH_WINDOW_DAYS * 86_400_000;

type Candidate = {
  id: string;
  accountId: string;
  amountKey: string;
  time: number;
};

/**
 * Money is a Decimal in Prisma — never compare two of them with `===`. Keying
 * on a fixed-2 string matches how the rest of the services coerce amounts.
 */
const amountKey = (amount: unknown): string => Number(amount).toFixed(2);

/**
 * Greedily pairs the user's unmatched EXPENSE transactions with unmatched
 * INCOME transactions on a *different* account, for the same amount, dated
 * within {@link MATCH_WINDOW_DAYS} of each other — the two legs of a transfer
 * between the user's own accounts (e.g. paying a credit card from checking).
 *
 * Each transaction is consumed at most once per run: for every expense the
 * nearest-dated remaining income candidate wins, and both rows are flagged
 * `isTransfer` with a shared `transferMatchId` in one database transaction.
 */
export const matchTransfers = async (
  userId: string,
  /**
   * When given (the CSV-import path knows the imported rows' date range),
   * bounds the scan to that range padded by the match window on each side —
   * a match can't land outside it. Omitted for the manual "Match transfers"
   * button, which has no range to bound by and falls back to a full scan.
   */
  dateRange?: { from: Date; to: Date },
): Promise<{ matched: number }> => {
  const rows = await prisma.transaction.findMany({
    // A reimbursable expense or a transaction with an active reimbursement
    // link (either side) is excluded: matchTransfers runs automatically after
    // every CSV import, and without this guard it could silently flag a
    // reimbursement-linked row as a transfer, violating the mutual-exclusion
    // invariant with no user action and no error (the caller swallows
    // failures from this function). A spread expense is excluded for the same
    // reason: it's real spending by definition, and flagging it a transfer
    // would break the spread/transfer exclusion.
    where: {
      userId,
      isTransfer: false,
      isReimbursable: false,
      spreadMonths: null,
      reimbursementExpenseLinks: { none: {} },
      reimbursementIncomeLinks: { none: {} },
      ...(dateRange && {
        date: {
          gte: new Date(dateRange.from.getTime() - MATCH_WINDOW_MS),
          lte: new Date(dateRange.to.getTime() + MATCH_WINDOW_MS),
        },
      }),
    },
    select: { id: true, accountId: true, amount: true, type: true, date: true },
    orderBy: { date: 'asc' },
  });

  const expenses: Candidate[] = [];
  const incomeByAmount = new Map<string, Candidate[]>();

  for (const row of rows) {
    const candidate: Candidate = {
      id: row.id,
      accountId: row.accountId,
      amountKey: amountKey(row.amount),
      time: row.date.getTime(),
    };
    if (row.type === 'EXPENSE') {
      expenses.push(candidate);
    } else {
      const bucket = incomeByAmount.get(candidate.amountKey);
      if (bucket) bucket.push(candidate);
      else incomeByAmount.set(candidate.amountKey, [candidate]);
    }
  }

  const consumed = new Set<string>();
  const pairs: Array<[string, string]> = [];

  for (const expense of expenses) {
    const bucket = incomeByAmount.get(expense.amountKey);
    if (!bucket) continue;

    let best: Candidate | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const income of bucket) {
      if (consumed.has(income.id)) continue;
      if (income.accountId === expense.accountId) continue;
      const distance = Math.abs(income.time - expense.time);
      if (distance > MATCH_WINDOW_MS) continue;
      if (distance < bestDistance) {
        best = income;
        bestDistance = distance;
      }
    }

    if (!best) continue;
    consumed.add(best.id);
    consumed.add(expense.id);
    pairs.push([expense.id, best.id]);
  }

  if (pairs.length > 0) {
    await prisma.$transaction(
      pairs.flatMap(([expenseId, incomeId]) => {
        const transferMatchId = randomUUID();
        return [
          prisma.transaction.update({
            where: { id: expenseId },
            data: { isTransfer: true, transferMatchId },
          }),
          prisma.transaction.update({
            where: { id: incomeId },
            data: { isTransfer: true, transferMatchId },
          }),
        ];
      }),
    );
  }

  return { matched: pairs.length };
};
