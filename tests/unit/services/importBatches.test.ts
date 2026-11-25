import { beforeEach, describe, expect, it, vi } from 'vitest';

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    importBatch: { findFirst: vi.fn(), findMany: vi.fn(), update: vi.fn() },
    transaction: { deleteMany: vi.fn(), findMany: vi.fn(), updateMany: vi.fn() },
    reimbursementLink: { count: vi.fn() },
    $transaction: vi.fn(),
  },
}));

vi.mock('@/lib/db/prisma', () => ({ prisma: prismaMock }));

const {
  normalizeFilename,
  findActiveBatchByFilename,
  listImportBatches,
  getImportBatch,
  undoImportBatch,
} = await import('@/lib/services/importBatches');
const { BatchAlreadyUndoneError, ReimbursementConflictError, ServiceValidationError } =
  await import('@/lib/services/common');

const dbBatch = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'batch-1',
  userId: 'user-1',
  accountId: 'acc-1',
  filename: 'march.csv',
  filenameNormalized: 'march.csv',
  status: 'ACTIVE',
  rowCount: 10,
  importedCount: 8,
  skippedDuplicates: 2,
  dateFrom: new Date('2026-03-01'),
  dateTo: new Date('2026-03-31'),
  createdAt: new Date('2026-04-01'),
  undoneAt: null,
  account: { name: 'Visa' },
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  // run the $transaction callback against a tx-shaped mock
  prismaMock.$transaction.mockImplementation(
    async (fn: (tx: typeof prismaMock) => Promise<unknown>) => fn(prismaMock),
  );
  prismaMock.reimbursementLink.count.mockResolvedValue(0);
  prismaMock.transaction.findMany.mockResolvedValue([]);
});

describe('normalizeFilename', () => {
  it('lowercases', () => {
    expect(normalizeFilename('March.CSV')).toBe('march.csv');
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeFilename('  march.csv  ')).toBe('march.csv');
  });

  it('is idempotent on already-normalized input', () => {
    expect(normalizeFilename('march.csv')).toBe('march.csv');
  });
});

describe('findActiveBatchByFilename', () => {
  it('queries only active batches on the given account, newest first', async () => {
    prismaMock.importBatch.findFirst.mockResolvedValue(dbBatch());

    const result = await findActiveBatchByFilename('user-1', 'acc-1', '  March.CSV ');

    expect(prismaMock.importBatch.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          userId: 'user-1',
          accountId: 'acc-1',
          filenameNormalized: 'march.csv',
          status: 'ACTIVE',
        },
        orderBy: { createdAt: 'desc' },
      }),
    );
    expect(result).toEqual({
      id: 'batch-1',
      filename: 'march.csv',
      accountId: 'acc-1',
      accountName: 'Visa',
      status: 'ACTIVE',
      rowCount: 10,
      importedCount: 8,
      skippedDuplicates: 2,
      dateFrom: new Date('2026-03-01').toISOString(),
      dateTo: new Date('2026-03-31').toISOString(),
      createdAt: new Date('2026-04-01').toISOString(),
      undoneAt: null,
    });
  });

  it('scopes the lookup to the requested account, not globally', async () => {
    prismaMock.importBatch.findFirst.mockResolvedValue(null);

    await findActiveBatchByFilename('user-1', 'acc-2', 'march.csv');

    const where = prismaMock.importBatch.findFirst.mock.calls[0][0].where;
    expect(where.accountId).toBe('acc-2');
  });

  it('returns null (no throw) when nothing matches, e.g. the only match is UNDONE', async () => {
    prismaMock.importBatch.findFirst.mockResolvedValue(null);

    await expect(findActiveBatchByFilename('user-1', 'acc-1', 'march.csv')).resolves.toBeNull();
    expect(prismaMock.importBatch.findFirst.mock.calls[0][0].where.status).toBe('ACTIVE');
  });

  it('returns the newest active batch when two share a filename', async () => {
    // legal after an explicit override (decision 1); the createdAt ordering above
    // is what picks the newer one, not a manual sort in the service
    prismaMock.importBatch.findFirst.mockResolvedValue(
      dbBatch({ id: 'batch-2', createdAt: new Date('2026-05-01') }),
    );

    const result = await findActiveBatchByFilename('user-1', 'acc-1', 'march.csv');

    expect(result?.id).toBe('batch-2');
  });
});

describe('listImportBatches', () => {
  it('returns nextCursor null when fewer than limit + 1 rows come back', async () => {
    prismaMock.importBatch.findMany.mockResolvedValue([dbBatch(), dbBatch({ id: 'batch-2' })]);

    const result = await listImportBatches('user-1', { limit: 25 });

    expect(result.batches).toHaveLength(2);
    expect(result.nextCursor).toBeNull();
  });

  it('drops the extra row and returns a cursor when a further page exists', async () => {
    prismaMock.importBatch.findMany.mockResolvedValue([
      dbBatch({ id: 'batch-1' }),
      dbBatch({ id: 'batch-2' }),
      dbBatch({ id: 'batch-3' }),
    ]);

    const result = await listImportBatches('user-1', { limit: 2 });

    expect(result.batches.map((b) => b.id)).toEqual(['batch-1', 'batch-2']);
    // the cursor is the last row of *this* page: the next request pairs it with
    // `skip: 1`, so cursoring on the dropped row would lose it entirely
    expect(result.nextCursor).toBe('batch-2');
    expect(prismaMock.importBatch.findMany.mock.calls[0][0].take).toBe(3);
  });

  it('passes cursor + skip: 1 when a cursor is supplied', async () => {
    prismaMock.importBatch.findMany.mockResolvedValue([]);

    await listImportBatches('user-1', { limit: 25, cursor: 'batch-9' });

    expect(prismaMock.importBatch.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ cursor: { id: 'batch-9' }, skip: 1 }),
    );
  });

  it('passes neither cursor nor skip when no cursor is supplied', async () => {
    prismaMock.importBatch.findMany.mockResolvedValue([]);

    await listImportBatches('user-1', { limit: 25 });

    const args = prismaMock.importBatch.findMany.mock.calls[0][0];
    expect('cursor' in args).toBe(false);
    expect('skip' in args).toBe(false);
  });

  it('orders by createdAt desc with an id tie-break', async () => {
    prismaMock.importBatch.findMany.mockResolvedValue([]);

    await listImportBatches('user-1', { limit: 25 });

    expect(prismaMock.importBatch.findMany.mock.calls[0][0].orderBy).toEqual([
      { createdAt: 'desc' },
      { id: 'desc' },
    ]);
  });

  it('includes undone batches in history', async () => {
    prismaMock.importBatch.findMany.mockResolvedValue([
      dbBatch({ id: 'batch-1' }),
      dbBatch({ id: 'batch-2', status: 'UNDONE', undoneAt: new Date('2026-05-02') }),
    ]);

    const result = await listImportBatches('user-1', { limit: 25 });

    expect(result.batches.map((b) => b.status)).toEqual(['ACTIVE', 'UNDONE']);
    expect(result.batches[1].undoneAt).toBe(new Date('2026-05-02').toISOString());
    expect(prismaMock.importBatch.findMany.mock.calls[0][0].where).toEqual({ userId: 'user-1' });
  });
});

describe('getImportBatch', () => {
  it('returns the mapped batch, with undoneAt null for an active one', async () => {
    prismaMock.importBatch.findFirst.mockResolvedValue(dbBatch());

    const result = await getImportBatch('user-1', 'batch-1');

    expect(result.undoneAt).toBeNull();
    expect(result.accountName).toBe('Visa');
  });

  it('maps undoneAt to an ISO string for an undone batch', async () => {
    prismaMock.importBatch.findFirst.mockResolvedValue(
      dbBatch({ status: 'UNDONE', undoneAt: new Date('2026-05-02') }),
    );

    const result = await getImportBatch('user-1', 'batch-1');

    expect(result.status).toBe('UNDONE');
    expect(result.undoneAt).toBe(new Date('2026-05-02').toISOString());
  });

  it('throws when the batch is missing or owned by another user', async () => {
    prismaMock.importBatch.findFirst.mockResolvedValue(null);

    await expect(getImportBatch('user-1', 'batch-x')).rejects.toThrow(ServiceValidationError);
    expect(prismaMock.importBatch.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'batch-x', userId: 'user-1' } }),
    );
  });
});

describe('undoImportBatch', () => {
  it('un-marks transfer pairs that have a leg in the batch before deleting it', async () => {
    prismaMock.importBatch.findFirst.mockResolvedValue(dbBatch());
    prismaMock.transaction.findMany.mockResolvedValue([
      { transferMatchId: 'match-1' },
      { transferMatchId: 'match-1' },
      { transferMatchId: 'match-2' },
    ]);
    prismaMock.transaction.deleteMany.mockResolvedValue({ count: 8 });
    prismaMock.importBatch.update.mockResolvedValue(dbBatch({ status: 'UNDONE' }));

    await undoImportBatch('user-1', 'batch-1');

    expect(prismaMock.transaction.findMany).toHaveBeenCalledWith({
      where: { userId: 'user-1', importBatchId: 'batch-1', transferMatchId: { not: null } },
      select: { transferMatchId: true },
    });
    expect(prismaMock.transaction.updateMany).toHaveBeenCalledWith({
      where: { userId: 'user-1', transferMatchId: { in: ['match-1', 'match-2'] } },
      data: { isTransfer: false, transferMatchId: null },
    });
    const unlinkOrder = prismaMock.transaction.updateMany.mock.invocationCallOrder[0];
    const deleteOrder = prismaMock.transaction.deleteMany.mock.invocationCallOrder[0];
    expect(unlinkOrder).toBeLessThan(deleteOrder);
  });

  it('skips the unlink when no row in the batch is a matched transfer', async () => {
    prismaMock.importBatch.findFirst.mockResolvedValue(dbBatch());
    prismaMock.transaction.deleteMany.mockResolvedValue({ count: 8 });
    prismaMock.importBatch.update.mockResolvedValue(dbBatch({ status: 'UNDONE' }));

    await undoImportBatch('user-1', 'batch-1');

    expect(prismaMock.transaction.updateMany).not.toHaveBeenCalled();
  });

  it('deletes the batch transactions and flips the batch to undone', async () => {
    prismaMock.importBatch.findFirst.mockResolvedValue(dbBatch());
    prismaMock.transaction.deleteMany.mockResolvedValue({ count: 8 });
    prismaMock.importBatch.update.mockResolvedValue(
      dbBatch({ status: 'UNDONE', undoneAt: new Date('2026-05-02') }),
    );

    const result = await undoImportBatch('user-1', 'batch-1');

    expect(prismaMock.transaction.deleteMany).toHaveBeenCalledWith({
      where: { userId: 'user-1', importBatchId: 'batch-1' },
    });
    expect(prismaMock.importBatch.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'batch-1' },
        data: { status: 'UNDONE', undoneAt: expect.any(Date) },
      }),
    );
    expect(result.deletedTransactions).toBe(8);
    expect(result.batch.status).toBe('UNDONE');
    expect(result.batch.undoneAt).toBe(new Date('2026-05-02').toISOString());
  });

  it('throws BatchAlreadyUndoneError without touching any data', async () => {
    prismaMock.importBatch.findFirst.mockResolvedValue(dbBatch({ status: 'UNDONE' }));

    await expect(undoImportBatch('user-1', 'batch-1')).rejects.toThrow(BatchAlreadyUndoneError);
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
    expect(prismaMock.transaction.deleteMany).not.toHaveBeenCalled();
  });

  it('throws ServiceValidationError for an unowned or missing batch', async () => {
    prismaMock.importBatch.findFirst.mockResolvedValue(null);

    await expect(undoImportBatch('user-1', 'batch-x')).rejects.toThrow(ServiceValidationError);
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
    expect(prismaMock.transaction.deleteMany).not.toHaveBeenCalled();
  });

  it('blocks the whole undo when any transaction in the batch has an active reimbursement link', async () => {
    prismaMock.importBatch.findFirst.mockResolvedValue(dbBatch());
    prismaMock.reimbursementLink.count.mockResolvedValue(1);

    await expect(undoImportBatch('user-1', 'batch-1')).rejects.toThrow(ReimbursementConflictError);
    expect(prismaMock.transaction.deleteMany).not.toHaveBeenCalled();
    expect(prismaMock.importBatch.update).not.toHaveBeenCalled();
  });

  it('checks for active links inside the same transaction as the delete', async () => {
    prismaMock.importBatch.findFirst.mockResolvedValue(dbBatch());
    prismaMock.reimbursementLink.count.mockResolvedValue(0);
    prismaMock.transaction.deleteMany.mockResolvedValue({ count: 8 });
    prismaMock.importBatch.update.mockResolvedValue(dbBatch({ status: 'UNDONE' }));

    await undoImportBatch('user-1', 'batch-1');

    expect(prismaMock.reimbursementLink.count).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: 'user-1',
          OR: [{ expense: { importBatchId: 'batch-1' } }, { income: { importBatchId: 'batch-1' } }],
        }),
      }),
    );
  });

  it('undoes normally when no transaction in the batch has an active link', async () => {
    prismaMock.importBatch.findFirst.mockResolvedValue(dbBatch());
    prismaMock.reimbursementLink.count.mockResolvedValue(0);
    prismaMock.transaction.deleteMany.mockResolvedValue({ count: 8 });
    prismaMock.importBatch.update.mockResolvedValue(dbBatch({ status: 'UNDONE' }));

    const result = await undoImportBatch('user-1', 'batch-1');

    expect(result.deletedTransactions).toBe(8);
  });
});
