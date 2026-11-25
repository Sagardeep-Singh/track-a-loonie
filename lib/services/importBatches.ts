import { prisma } from '@/lib/db/prisma';
import {
  BatchAlreadyUndoneError,
  ReimbursementConflictError,
  ServiceValidationError,
} from '@/lib/services/common';
import { transferMatchIdsOf, unlinkTransferLegs } from '@/lib/services/transfers';
import type { ListImportBatchesQuery } from '@/lib/validators/import-batches';

export type FrontendImportBatch = {
  id: string;
  filename: string;
  accountId: string;
  accountName: string;
  status: 'ACTIVE' | 'UNDONE';
  rowCount: number;
  importedCount: number;
  skippedDuplicates: number;
  dateFrom: string;
  dateTo: string;
  createdAt: string;
  undoneAt: string | null;
};

const include = { account: { select: { name: true } } } as const;

const toFrontendImportBatch = (batch: {
  id: string;
  filename: string;
  accountId: string;
  status: string;
  rowCount: number;
  importedCount: number;
  skippedDuplicates: number;
  dateFrom: Date;
  dateTo: Date;
  createdAt: Date;
  undoneAt: Date | null;
  account: { name: string };
}): FrontendImportBatch => ({
  id: batch.id,
  filename: batch.filename,
  accountId: batch.accountId,
  accountName: batch.account.name,
  status: batch.status === 'UNDONE' ? 'UNDONE' : 'ACTIVE',
  rowCount: batch.rowCount,
  importedCount: batch.importedCount,
  skippedDuplicates: batch.skippedDuplicates,
  dateFrom: batch.dateFrom.toISOString(),
  dateTo: batch.dateTo.toISOString(),
  createdAt: batch.createdAt.toISOString(),
  undoneAt: batch.undoneAt?.toISOString() ?? null,
});

/**
 * Decision 3: case-insensitive + trimmed. Single source of truth, used identically
 * at the preview check, the commit check, and at storage time.
 */
export const normalizeFilename = (filename: string): string => filename.trim().toLowerCase();

/**
 * The active batch on this account whose normalized filename matches, or null.
 * Advisory-only at preview; the 409 gate at commit.
 *
 * `findFirst`, not `findUnique`: there is no unique constraint. Multiple UNDONE rows
 * may share a filename (decision 4), and an explicit override can create a second
 * ACTIVE one (decision 1), so the newest active batch wins.
 */
export const findActiveBatchByFilename = async (
  userId: string,
  accountId: string,
  filename: string,
): Promise<FrontendImportBatch | null> => {
  const batch = await prisma.importBatch.findFirst({
    where: {
      userId,
      accountId,
      filenameNormalized: normalizeFilename(filename),
      status: 'ACTIVE',
    },
    include,
    orderBy: { createdAt: 'desc' },
  });
  return batch ? toFrontendImportBatch(batch) : null;
};

/** Most-recent-first, cursor-paginated. Includes UNDONE batches (story 3). */
export const listImportBatches = async (
  userId: string,
  query: ListImportBatchesQuery,
): Promise<{ batches: FrontendImportBatch[]; nextCursor: string | null }> => {
  const batches = await prisma.importBatch.findMany({
    where: { userId },
    include,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: query.limit + 1,
    ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
  });

  // One extra row was requested purely to detect a further page; it is the cursor,
  // not part of this page.
  const hasMore = batches.length > query.limit;
  const page = hasMore ? batches.slice(0, query.limit) : batches;

  return {
    batches: page.map(toFrontendImportBatch),
    nextCursor: hasMore ? page[page.length - 1].id : null,
  };
};

export const getImportBatch = async (
  userId: string,
  batchId: string,
): Promise<FrontendImportBatch> => {
  // the `userId` in the where clause is the ownership check
  const batch = await prisma.importBatch.findFirst({
    where: { id: batchId, userId },
    include,
  });
  if (!batch) {
    throw new ServiceValidationError('Import batch not found');
  }
  return toFrontendImportBatch(batch);
};

/**
 * Deletes every transaction created by this batch and flips the batch to UNDONE,
 * in one `prisma.$transaction` — never a bare FK cascade (decision 9). The batch row
 * itself is kept so it stays in history and frees its filename for reuse.
 */
export const undoImportBatch = async (
  userId: string,
  batchId: string,
): Promise<{ batch: FrontendImportBatch; deletedTransactions: number }> => {
  const existing = await prisma.importBatch.findFirst({ where: { id: batchId, userId } });
  if (!existing) {
    throw new ServiceValidationError('Import batch not found');
  }
  if (existing.status === 'UNDONE') {
    throw new BatchAlreadyUndoneError('This import has already been undone');
  }

  const { batch, count } = await prisma.$transaction(async (tx) => {
    const linked = await tx.reimbursementLink.count({
      where: {
        userId,
        OR: [{ expense: { importBatchId: batchId } }, { income: { importBatchId: batchId } }],
      },
    });
    if (linked > 0) {
      throw new ReimbursementConflictError(
        'Some transactions in this import are linked to reimbursements. Remove those links before undoing it.',
      );
    }

    // a leg in this batch may be matched to one outside it (the other bank's
    // statement, a manual entry); un-mark the pair so the survivor counts again
    const matchIds = transferMatchIdsOf(
      await tx.transaction.findMany({
        where: { userId, importBatchId: batchId, transferMatchId: { not: null } },
        select: { transferMatchId: true },
      }),
    );
    if (matchIds.length > 0) {
      await unlinkTransferLegs(tx, userId, matchIds);
    }

    const deleted = await tx.transaction.deleteMany({
      where: { userId, importBatchId: batchId },
    });
    const updated = await tx.importBatch.update({
      where: { id: batchId },
      data: { status: 'UNDONE', undoneAt: new Date() },
      include,
    });
    return { batch: updated, count: deleted.count };
  });

  return { batch: toFrontendImportBatch(batch), deletedTransactions: count };
};
