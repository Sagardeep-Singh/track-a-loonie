import { prisma } from '@/lib/db/prisma';
import { toCents } from '@/lib/services/reimbursements';
import { allocateSpread } from '@/lib/spread';

export type SpreadShareRow = {
  transactionId: string;
  categoryId: string | null;
  categoryName: string | null;
  payee: string | null;
  /** the real payment's own date (ISO), which may sit outside the share's month */
  date: string;
  month: number;
  amount: string;
};

/**
 * The reporting-side replacement for a spread expense: one row per
 * (transaction, month) for every spread EXPENSE whose window overlaps
 * `[fromMonth, toMonth]` (YYYYMM, inclusive). Queried by window rather than
 * by `date`, so a June payment spread Jan-Dec shows up in a March read.
 *
 * Budgets/overview/trends drop spread rows from their own date-based queries
 * (`spreadMonths: null`) and add these instead, so nothing is counted twice.
 */
export const listSpreadSharesInRange = async (
  userId: string,
  fromMonth: number,
  toMonth: number,
): Promise<SpreadShareRow[]> => {
  const rows = await prisma.transaction.findMany({
    where: {
      userId,
      type: 'EXPENSE',
      isTransfer: false,
      spreadMonths: { not: null },
      spreadStartMonth: { lte: toMonth },
      spreadEndMonth: { gte: fromMonth },
    },
    select: {
      id: true,
      amount: true,
      categoryId: true,
      payee: true,
      date: true,
      category: { select: { name: true } },
      spreadStartMonth: true,
      spreadMonths: true,
    },
  });

  return rows.flatMap((t) => {
    if (t.spreadStartMonth == null || t.spreadMonths == null) return [];
    return allocateSpread(toCents(t.amount), t.spreadStartMonth, t.spreadMonths)
      .filter((share) => share.month >= fromMonth && share.month <= toMonth)
      .map((share) => ({
        transactionId: t.id,
        categoryId: t.categoryId,
        categoryName: t.category?.name ?? null,
        payee: t.payee,
        date: t.date.toISOString(),
        month: share.month,
        amount: (share.cents / 100).toFixed(2),
      }));
  });
};
