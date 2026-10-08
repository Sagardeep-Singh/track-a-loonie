import { fromDateKey, toDateKey } from '@/lib/date';
import { prisma } from '@/lib/db/prisma';
import { DuplicateFilenameError, ServiceValidationError } from '@/lib/services/common';
import { compileRuleMatcher } from '@/lib/services/categorize';
import {
  findActiveBatchByFilename,
  normalizeFilename,
  type FrontendImportBatch,
} from '@/lib/services/importBatches';
import { matchTransfers } from '@/lib/services/transfers';
import type {
  CommitImportInput,
  ImportRowInput,
  PreviewImportInput,
} from '@/lib/validators/csv-import';

export type PreviewRow = ImportRowInput & { categoryName: string | null };

export type FilenameWarning = {
  /** the matched active batch, so the client can name it */
  batch: FrontendImportBatch;
  /** this file's submitted row count */
  submittedRowCount: number;
  /** decision 5: compare submitted row counts, not post-dedupe ones */
  rowCountMatches: boolean;
  dateRangeMatches: boolean;
};

export type PreviewResult = {
  rows: PreviewRow[];
  filenameWarning: FilenameWarning | null;
};

export type RawImportRow = {
  accountId: string;
  date: string;
  amount: number;
  type: 'INCOME' | 'EXPENSE';
  payee?: string;
  note?: string;
};

/**
 * Preview and commit rows and existing DB rows all go through this with a
 * `Date`, so the day part is always the same UTC `YYYY-MM-DD`. (Preview used
 * to pass the raw CSV string, so `10/05/2026` never matched `2026-10-05`.)
 */
const duplicateKey = (row: {
  accountId: string;
  date: Date;
  amount: number;
  payee?: string | null;
}): string => `${row.accountId}|${toDateKey(row.date)}|${row.amount.toFixed(2)}|${row.payee ?? ''}`;

/** the validator already guarantees a real `YYYY-MM-DD`; this only narrows the type */
const rowDate = (key: string): Date => {
  const date = fromDateKey(key);
  if (!date) throw new ServiceValidationError(`Invalid date: ${key}`);
  return date;
};

/** min/max transaction date across a set of rows, used for the batch's date range */
const dateRange = (dates: Date[]): { dateFrom: Date; dateTo: Date } => {
  const times = dates.map((d) => d.getTime());
  return { dateFrom: new Date(Math.min(...times)), dateTo: new Date(Math.max(...times)) };
};

const DAY_MS = 86_400_000;

/**
 * Banks can date the same transaction a day apart across exports (pending vs
 * posted), so a match on an adjacent day counts as a possible duplicate too.
 */
const matchesExisting = (
  existingKeys: Set<string>,
  row: { accountId: string; date: Date; amount: number; payee?: string | null },
): boolean =>
  [-DAY_MS, 0, DAY_MS].some((offset) =>
    existingKeys.has(duplicateKey({ ...row, date: new Date(row.date.getTime() + offset) })),
  );

/**
 * A duplicate can only exist on a date present in the submitted rows
 * (`duplicateKey` includes the day), so the existing-rows scan is bound to
 * that range instead of the user's entire history. Padded a day each side
 * so `matchesExisting` can see adjacent-day matches at the range's edges.
 */
const loadExistingKeys = async (
  userId: string,
  dateFrom: Date,
  dateTo: Date,
): Promise<Set<string>> => {
  const existing = await prisma.transaction.findMany({
    where: {
      userId,
      date: {
        gte: new Date(dateFrom.getTime() - DAY_MS),
        lte: new Date(dateTo.getTime() + DAY_MS),
      },
    },
    select: { accountId: true, date: true, amount: true, payee: true },
  });
  return new Set(
    existing.map((t) => duplicateKey({ ...t, date: t.date, amount: Number(t.amount) })),
  );
};

export const previewImport = async (
  userId: string,
  input: PreviewImportInput,
): Promise<PreviewResult> => {
  const dated = input.rows.map((row) => ({ ...row, date: rowDate(row.date) }));
  const { dateFrom: rowsDateFrom, dateTo: rowsDateTo } = dateRange(dated.map((r) => r.date));
  const [rules, categories, existingKeys, conflict] = await Promise.all([
    prisma.categoryRule.findMany({
      where: { userId },
      select: { categoryId: true, matchText: true, priority: true },
    }),
    prisma.category.findMany({ where: { userId }, select: { id: true, name: true } }),
    loadExistingKeys(userId, rowsDateFrom, rowsDateTo),
    findActiveBatchByFilename(userId, input.accountId, input.filename),
  ]);

  const categoryNames = new Map(categories.map((c) => [c.id, c.name]));
  const seenInBatch = new Set<string>();

  // Compiled once and reused across every row instead of recompiling per
  // row per rule for a large CSV.
  const matchers = [...rules]
    .sort((a, b) => a.priority - b.priority)
    .map((r) => ({ categoryId: r.categoryId, matcher: compileRuleMatcher(r.matchText) }));

  const rows = dated.map((row) => {
    const text = `${row.payee ?? ''} ${row.note ?? ''}`;
    const categoryId = matchers.find((m) => m.matcher.test(text))?.categoryId ?? null;
    const key = duplicateKey(row);
    // flag against existing DB rows, and against an earlier row in this same
    // file (two identical CSV rows shouldn't both import silently)
    const duplicate = matchesExisting(existingKeys, row) || seenInBatch.has(key);
    seenInBatch.add(key);

    return {
      accountId: row.accountId,
      date: row.date,
      amount: row.amount,
      type: row.type,
      payee: row.payee,
      note: row.note,
      categoryId,
      categoryName: categoryId ? (categoryNames.get(categoryId) ?? null) : null,
      include: !duplicate,
      duplicate,
    };
  });

  // Advisory only (story 2): the warning never excludes or mutates a row.
  let filenameWarning: FilenameWarning | null = null;
  if (conflict) {
    const { dateFrom, dateTo } = dateRange(rows.map((r) => r.date));
    filenameWarning = {
      batch: conflict,
      submittedRowCount: rows.length,
      rowCountMatches: rows.length === conflict.rowCount,
      dateRangeMatches:
        dateFrom.toISOString() === conflict.dateFrom && dateTo.toISOString() === conflict.dateTo,
    };
  }

  return { rows, filenameWarning };
};

export const commitImport = async (
  userId: string,
  input: CommitImportInput,
): Promise<{ batchId: string | null; imported: number; skippedDuplicates: number }> => {
  const account = await prisma.account.findFirst({
    where: { id: input.accountId, userId },
    select: { id: true },
  });
  if (!account) {
    throw new ServiceValidationError('Account not found');
  }

  // Ordering is normative: the filename gate runs *before* row-level dedupe and
  // before the zero-row early return. Re-importing an identical file makes every
  // row a row-level duplicate, which would otherwise return `imported: 0` and never
  // surface the conflict at all.
  const conflict = await findActiveBatchByFilename(userId, input.accountId, input.filename);
  if (conflict && !input.overrideDuplicateFilename) {
    throw new DuplicateFilenameError(
      `"${conflict.filename}" was already imported into this account`,
      conflict,
    );
  }

  // metrics span every *submitted* row, including excluded ones, so the preview
  // comparison against a prior batch is like-for-like (decision 5)
  const { dateFrom, dateTo } = dateRange(input.rows.map((r) => r.date));

  // Re-check against the database at commit time, not just whatever the
  // client's preview said: the preview snapshot goes stale the moment a
  // commit happens (e.g. a resubmitted/duplicated request), so trusting the
  // client-supplied `include` flag alone would let already-imported rows
  // back in.
  const existingKeys = await loadExistingKeys(userId, dateFrom, dateTo);
  const requested = input.rows.filter((r) => r.include);
  const seenInBatch = new Set<string>();
  const rowsToImport = requested.filter((row) => {
    const key = duplicateKey(row);
    if (row.duplicate) {
      // flagged as a duplicate at preview and still included: an explicit user
      // override (story 2a), so neither key check applies. Still seeded into
      // `seenInBatch` so a later non-flagged row with this key dedupes.
      seenInBatch.add(key);
      return true;
    }
    // not flagged at preview but matching now: stale preview / double submit.
    // Unchanged protection.
    if (matchesExisting(existingKeys, row) || seenInBatch.has(key)) return false;
    seenInBatch.add(key);
    return true;
  });
  const skippedDuplicates = requested.length - rowsToImport.length;

  if (rowsToImport.length === 0) {
    // no batch created, so no filename is reserved (story 1)
    return { batchId: null, imported: 0, skippedDuplicates };
  }

  const { batchId, imported } = await prisma.$transaction(async (tx) => {
    // batch first: the transactions' foreign key requires it to exist
    const batch = await tx.importBatch.create({
      data: {
        userId,
        accountId: input.accountId,
        filename: input.filename,
        filenameNormalized: normalizeFilename(input.filename),
        rowCount: input.rows.length,
        importedCount: rowsToImport.length,
        skippedDuplicates,
        dateFrom,
        dateTo,
      },
    });
    const created = await tx.transaction.createMany({
      data: rowsToImport.map((row) => ({
        userId,
        accountId: row.accountId,
        categoryId: row.categoryId ?? null,
        amount: Math.abs(row.amount),
        type: row.type,
        date: row.date,
        payee: row.payee,
        note: row.note,
        importBatchId: batch.id,
      })),
    });
    return { batchId: batch.id, imported: created.count };
  });

  // Freshly imported rows are the common case for a transfer pair landing in
  // the ledger (both sides come off statements), so pair them up immediately.
  // Best-effort: the rows are already committed, and matching can be re-run
  // from the transactions screen, so a failure here must not fail the import.
  try {
    await matchTransfers(userId, { from: dateFrom, to: dateTo });
  } catch {
    // swallowed deliberately — see above
  }

  return { batchId, imported, skippedDuplicates };
};
