import { prisma } from '@/lib/db/prisma';
import { getHistoryFloor } from '@/lib/services/entitlements';

/** Only counts that prompt the user to act belong in the nav. */
export type NavCounts = {
  categorize: number;
};

export const getNavCounts = async (userId: string): Promise<NavCounts> => {
  // Mirrors the Categorize queue filter: skipped rows, transfer legs and card
  // payments never need a category, so they must not inflate the badge.
  const floor = await getHistoryFloor(userId);
  const categorize = await prisma.transaction.count({
    where: {
      userId,
      categoryId: null,
      skippedAt: null,
      isTransfer: false,
      isPayment: false,
      ...(floor ? { date: { gte: floor } } : {}),
    },
  });

  return { categorize };
};
