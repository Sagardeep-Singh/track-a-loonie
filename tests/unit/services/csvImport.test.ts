import { beforeEach, describe, expect, it, vi } from 'vitest';
import { commitImportSchema, previewImportSchema } from '@/lib/validators/csv-import';

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    categoryRule: { findMany: vi.fn() },
    category: { findMany: vi.fn() },
    transaction: { findMany: vi.fn(), createMany: vi.fn() },
    account: { findFirst: vi.fn() },
    importBatch: { findFirst: vi.fn(), create: vi.fn() },
    $transaction: vi.fn(),
  },
}));

const { matchTransfersMock } = vi.hoisted(() => ({
  matchTransfersMock: vi.fn(async () => ({ matched: 0 })),
}));

vi.mock('@/lib/db/prisma', () => ({ prisma: prismaMock }));
vi.mock('@/lib/services/transfers', () => ({ matchTransfers: matchTransfersMock }));

const { previewImport, commitImport } = await import('@/lib/services/csvImport');
const { DuplicateFilenameError, ServiceValidationError } = await import('@/lib/services/common');

const activeBatch = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'batch-1',
  userId: 'user-1',
  accountId: 'acc-1',
  filename: 'march.csv',
  filenameNormalized: 'march.csv',
  status: 'ACTIVE',
  rowCount: 1,
  importedCount: 1,
  skippedDuplicates: 0,
  dateFrom: new Date('2026-03-01'),
  dateTo: new Date('2026-03-01'),
  createdAt: new Date('2026-04-01'),
  undoneAt: null,
  account: { name: 'Visa' },
  ...overrides,
});

const commitRow = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  accountId: 'acc-1',
  date: new Date('2026-03-01'),
  amount: 42,
  type: 'EXPENSE' as const,
  payee: 'Coffee Shop',
  include: true,
  duplicate: false,
  ...overrides,
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const commit = (input: any): ReturnType<typeof commitImport> => commitImport('user-1', input);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const preview = (input: any): ReturnType<typeof previewImport> => previewImport('user-1', input);

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.transaction.findMany.mockResolvedValue([]);
  prismaMock.categoryRule.findMany.mockResolvedValue([]);
  prismaMock.category.findMany.mockResolvedValue([]);
  // no filename conflict unless a test says otherwise
  prismaMock.importBatch.findFirst.mockResolvedValue(null);
  prismaMock.importBatch.create.mockResolvedValue({ id: 'batch-new' });
  prismaMock.$transaction.mockImplementation(
    async (fn: (tx: typeof prismaMock) => Promise<unknown>) => fn(prismaMock),
  );
});

describe('previewImport', () => {
  it('flags a row as a duplicate when an identical transaction already exists', async () => {
    prismaMock.transaction.findMany.mockResolvedValue([
      { accountId: 'acc-1', date: new Date('2026-03-01'), amount: 42, payee: 'Coffee Shop' },
    ]);

    const result = await preview({
      accountId: 'acc-1',
      filename: 'march.csv',
      rows: [
        {
          accountId: 'acc-1',
          date: '2026-03-01',
          amount: 42,
          type: 'EXPENSE',
          payee: 'Coffee Shop',
        },
      ],
    });

    expect(result.rows[0].duplicate).toBe(true);
    expect(result.rows[0].include).toBe(false);
  });

  it('flags the second of two identical rows within the same file as a duplicate', async () => {
    const row = {
      accountId: 'acc-1',
      date: '2026-03-01',
      amount: 42,
      type: 'EXPENSE' as const,
      payee: 'Coffee Shop',
    };
    const result = await preview({
      accountId: 'acc-1',
      filename: 'march.csv',
      rows: [row, { ...row }],
    });

    expect(result.rows[0].duplicate).toBe(false);
    expect(result.rows[0].include).toBe(true);
    expect(result.rows[1].duplicate).toBe(true);
    expect(result.rows[1].include).toBe(false);
  });

  it('suggests a category from matching rules and includes non-duplicate rows', async () => {
    prismaMock.categoryRule.findMany.mockResolvedValue([
      { categoryId: 'cat-1', matchText: 'coffee', priority: 0 },
    ]);
    prismaMock.category.findMany.mockResolvedValue([{ id: 'cat-1', name: 'Dining' }]);

    const result = await preview({
      accountId: 'acc-1',
      filename: 'march.csv',
      rows: [
        {
          accountId: 'acc-1',
          date: '2026-03-02',
          amount: 10,
          type: 'EXPENSE',
          payee: 'Coffee Shop',
        },
      ],
    });

    expect(result.rows[0].categoryId).toBe('cat-1');
    expect(result.rows[0].categoryName).toBe('Dining');
    expect(result.rows[0].include).toBe(true);
  });

  it('bounds the existing-rows scan to the submitted rows date range, padded a day each side', async () => {
    await preview({
      accountId: 'acc-1',
      filename: 'march.csv',
      rows: [
        { accountId: 'acc-1', date: '2026-03-05', amount: 10, type: 'EXPENSE' },
        { accountId: 'acc-1', date: '2026-03-20', amount: 20, type: 'EXPENSE' },
      ],
    });

    expect(prismaMock.transaction.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: 'user-1',
          date: {
            gte: new Date('2026-03-04'),
            lte: new Date('2026-03-21'),
          },
        }),
      }),
    );
  });

  it('returns no filename warning when no active batch shares the name', async () => {
    const result = await preview({
      accountId: 'acc-1',
      filename: 'april.csv',
      rows: [{ accountId: 'acc-1', date: '2026-03-01', amount: 10, type: 'EXPENSE' }],
    });

    expect(result.filenameWarning).toBeNull();
  });

  it('warns with both signals matching when row count and date range line up', async () => {
    prismaMock.importBatch.findFirst.mockResolvedValue(activeBatch());

    const result = await preview({
      accountId: 'acc-1',
      filename: 'march.csv',
      rows: [{ accountId: 'acc-1', date: '2026-03-01', amount: 10, type: 'EXPENSE' }],
    });

    expect(result.filenameWarning?.batch.id).toBe('batch-1');
    expect(result.filenameWarning?.submittedRowCount).toBe(1);
    expect(result.filenameWarning?.rowCountMatches).toBe(true);
    expect(result.filenameWarning?.dateRangeMatches).toBe(true);
  });

  it('reports rowCountMatches false when the submitted row count differs', async () => {
    prismaMock.importBatch.findFirst.mockResolvedValue(activeBatch({ rowCount: 5 }));

    const result = await preview({
      accountId: 'acc-1',
      filename: 'march.csv',
      rows: [{ accountId: 'acc-1', date: '2026-03-01', amount: 10, type: 'EXPENSE' }],
    });

    expect(result.filenameWarning?.rowCountMatches).toBe(false);
    expect(result.filenameWarning?.dateRangeMatches).toBe(true);
  });

  it('reports dateRangeMatches false when the dates differ', async () => {
    prismaMock.importBatch.findFirst.mockResolvedValue(activeBatch());

    const result = await preview({
      accountId: 'acc-1',
      filename: 'march.csv',
      rows: [{ accountId: 'acc-1', date: '2026-03-09', amount: 10, type: 'EXPENSE' }],
    });

    expect(result.filenameWarning?.dateRangeMatches).toBe(false);
  });

  it('is advisory only: the warning never changes a row include/duplicate flag', async () => {
    prismaMock.importBatch.findFirst.mockResolvedValue(activeBatch());

    const result = await preview({
      accountId: 'acc-1',
      filename: 'march.csv',
      rows: [{ accountId: 'acc-1', date: '2026-03-01', amount: 10, type: 'EXPENSE' }],
    });

    expect(result.filenameWarning).not.toBeNull();
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].duplicate).toBe(false);
    expect(result.rows[0].include).toBe(true);
  });
});

describe('commitImport', () => {
  it('rejects when the account is not owned by the user', async () => {
    prismaMock.account.findFirst.mockResolvedValue(null);

    await expect(
      commit({ accountId: 'acc-missing', filename: 'march.csv', rows: [commitRow()] }),
    ).rejects.toThrow(ServiceValidationError);
  });

  it('only creates transactions for rows marked include', async () => {
    prismaMock.account.findFirst.mockResolvedValue({ id: 'acc-1' });
    prismaMock.transaction.createMany.mockResolvedValue({ count: 1 });

    const result = await commit({
      accountId: 'acc-1',
      filename: 'march.csv',
      rows: [
        commitRow({ amount: 10, payee: undefined }),
        commitRow({ amount: 5, payee: undefined, include: false }),
      ],
    });

    expect(prismaMock.transaction.createMany.mock.calls[0][0].data).toHaveLength(1);
    expect(result).toEqual({ batchId: 'batch-new', imported: 1, skippedDuplicates: 0 });
  });

  it('re-checks against the database and skips rows that already exist, even if included', async () => {
    prismaMock.account.findFirst.mockResolvedValue({ id: 'acc-1' });
    prismaMock.transaction.findMany.mockResolvedValue([
      { accountId: 'acc-1', date: new Date('2026-03-01'), amount: 42, payee: 'Coffee Shop' },
    ]);

    const result = await commit({
      accountId: 'acc-1',
      filename: 'march.csv',
      rows: [commitRow()],
    });

    // simulates a resubmitted/stale preview: the row looks includable to the
    // client, but a matching transaction already landed in the database
    expect(prismaMock.transaction.createMany).not.toHaveBeenCalled();
    expect(result).toEqual({ batchId: null, imported: 0, skippedDuplicates: 1 });
  });

  it('skips a second identical row within the same commit batch', async () => {
    prismaMock.account.findFirst.mockResolvedValue({ id: 'acc-1' });
    prismaMock.transaction.createMany.mockResolvedValue({ count: 1 });

    const result = await commit({
      accountId: 'acc-1',
      filename: 'march.csv',
      rows: [commitRow(), commitRow()],
    });

    expect(prismaMock.transaction.createMany.mock.calls[0][0].data).toHaveLength(1);
    expect(result).toEqual({ batchId: 'batch-new', imported: 1, skippedDuplicates: 1 });
  });

  it('rejects with DuplicateFilenameError and creates no batch when the filename conflicts', async () => {
    prismaMock.account.findFirst.mockResolvedValue({ id: 'acc-1' });
    prismaMock.importBatch.findFirst.mockResolvedValue(activeBatch());

    await expect(
      commit({ accountId: 'acc-1', filename: 'march.csv', rows: [commitRow()] }),
    ).rejects.toThrow(DuplicateFilenameError);
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
    expect(prismaMock.importBatch.create).not.toHaveBeenCalled();
  });

  it('creates a new independent batch when the filename conflict is overridden', async () => {
    prismaMock.account.findFirst.mockResolvedValue({ id: 'acc-1' });
    prismaMock.importBatch.findFirst.mockResolvedValue(activeBatch());
    prismaMock.transaction.createMany.mockResolvedValue({ count: 1 });

    const result = await commit({
      accountId: 'acc-1',
      filename: 'march.csv',
      rows: [commitRow()],
      overrideDuplicateFilename: true,
    });

    // a *new* batch, never a merge into or mutation of the conflicting one
    expect(prismaMock.importBatch.create).toHaveBeenCalledTimes(1);
    expect(result.batchId).toBe('batch-new');
  });

  it('surfaces the filename conflict even when every row is a row-level duplicate', async () => {
    // ordering guard: were the filename gate to run after dedupe, this would
    // return the zero-row shape and the 409 would never be seen
    prismaMock.account.findFirst.mockResolvedValue({ id: 'acc-1' });
    prismaMock.importBatch.findFirst.mockResolvedValue(activeBatch());
    prismaMock.transaction.findMany.mockResolvedValue([
      { accountId: 'acc-1', date: new Date('2026-03-01'), amount: 42, payee: 'Coffee Shop' },
    ]);

    await expect(
      commit({ accountId: 'acc-1', filename: 'march.csv', rows: [commitRow()] }),
    ).rejects.toThrow(DuplicateFilenameError);
  });

  it('creates no batch and reserves no filename on a zero-row commit', async () => {
    prismaMock.account.findFirst.mockResolvedValue({ id: 'acc-1' });

    const result = await commit({
      accountId: 'acc-1',
      filename: 'march.csv',
      rows: [commitRow({ include: false })],
    });

    expect(prismaMock.importBatch.create).not.toHaveBeenCalled();
    expect(result).toEqual({ batchId: null, imported: 0, skippedDuplicates: 0 });
  });

  it('imports a row the user explicitly overrode after it was flagged at preview', async () => {
    prismaMock.account.findFirst.mockResolvedValue({ id: 'acc-1' });
    prismaMock.transaction.findMany.mockResolvedValue([
      { accountId: 'acc-1', date: new Date('2026-03-01'), amount: 42, payee: 'Coffee Shop' },
    ]);
    prismaMock.transaction.createMany.mockResolvedValue({ count: 1 });

    const result = await commit({
      accountId: 'acc-1',
      filename: 'march.csv',
      rows: [commitRow({ duplicate: true })],
    });

    expect(prismaMock.transaction.createMany.mock.calls[0][0].data).toHaveLength(1);
    expect(result).toEqual({ batchId: 'batch-new', imported: 1, skippedDuplicates: 0 });
  });

  it('still skips a row that was not flagged at preview but matches now', async () => {
    prismaMock.account.findFirst.mockResolvedValue({ id: 'acc-1' });
    prismaMock.transaction.findMany.mockResolvedValue([
      { accountId: 'acc-1', date: new Date('2026-03-01'), amount: 42, payee: 'Coffee Shop' },
    ]);

    const result = await commit({
      accountId: 'acc-1',
      filename: 'march.csv',
      rows: [commitRow({ duplicate: false })],
    });

    expect(prismaMock.transaction.createMany).not.toHaveBeenCalled();
    expect(result).toEqual({ batchId: null, imported: 0, skippedDuplicates: 1 });
  });

  it('treats an absent duplicate flag as not-flagged and skips the row', async () => {
    // legacy/malformed client payload: the validator defaults `duplicate` to
    // false, so stale-preview protection still applies
    prismaMock.account.findFirst.mockResolvedValue({ id: 'acc-1' });
    prismaMock.transaction.findMany.mockResolvedValue([
      { accountId: 'acc-1', date: new Date('2026-03-01'), amount: 42, payee: 'Coffee Shop' },
    ]);

    // run the raw payload through the validator, so the default is the real one
    const parsed = commitImportSchema.parse({
      accountId: 'acc-1',
      filename: 'march.csv',
      rows: [
        {
          accountId: 'acc-1',
          date: '2026-03-01',
          amount: 42,
          type: 'EXPENSE',
          payee: 'Coffee Shop',
          include: true,
        },
      ],
    });
    const result = await commit(parsed);

    expect(prismaMock.transaction.createMany).not.toHaveBeenCalled();
    expect(result.skippedDuplicates).toBe(1);
  });

  it('records rowCount over all submitted rows, importedCount and skippedDuplicates separately', async () => {
    prismaMock.account.findFirst.mockResolvedValue({ id: 'acc-1' });
    prismaMock.transaction.findMany.mockResolvedValue([
      { accountId: 'acc-1', date: new Date('2026-03-10'), amount: 42, payee: 'Stale' },
    ]);
    prismaMock.transaction.createMany.mockResolvedValue({ count: 2 });

    const result = await commit({
      accountId: 'acc-1',
      filename: 'march.csv',
      rows: [
        // excluded rows still move the date range boundaries
        commitRow({ include: false, date: new Date('2026-03-01'), payee: 'Excluded early' }),
        commitRow({ include: false, date: new Date('2026-03-31'), payee: 'Excluded late' }),
        commitRow({ date: new Date('2026-03-10'), payee: 'Stale' }),
        commitRow({ date: new Date('2026-03-11'), payee: 'Fresh A' }),
        commitRow({ date: new Date('2026-03-12'), payee: 'Fresh B' }),
      ],
    });

    expect(result).toEqual({ batchId: 'batch-new', imported: 2, skippedDuplicates: 1 });
    const batchData = prismaMock.importBatch.create.mock.calls[0][0].data;
    expect(batchData.rowCount).toBe(5);
    expect(batchData.importedCount).toBe(2);
    expect(batchData.skippedDuplicates).toBe(1);
    expect(batchData.dateFrom).toEqual(new Date('2026-03-01'));
    expect(batchData.dateTo).toEqual(new Date('2026-03-31'));
    expect(batchData.filenameNormalized).toBe('march.csv');
  });

  it('stamps every created transaction with the batch id returned by the create call', async () => {
    prismaMock.account.findFirst.mockResolvedValue({ id: 'acc-1' });
    prismaMock.importBatch.create.mockResolvedValue({ id: 'batch-xyz' });
    prismaMock.transaction.createMany.mockResolvedValue({ count: 2 });

    await commit({
      accountId: 'acc-1',
      filename: 'march.csv',
      rows: [commitRow({ payee: 'A' }), commitRow({ payee: 'B' })],
    });

    const data = prismaMock.transaction.createMany.mock.calls[0][0].data;
    expect(data.every((row: { importBatchId: string }) => row.importBatchId === 'batch-xyz')).toBe(
      true,
    );
  });

  it('runs transfer matching after inserting the imported rows', async () => {
    prismaMock.account.findFirst.mockResolvedValue({ id: 'acc-1' });
    prismaMock.importBatch.create.mockResolvedValue({ id: 'batch-1' });
    prismaMock.transaction.createMany.mockResolvedValue({ count: 1 });

    await commit({
      accountId: 'acc-1',
      filename: 'march.csv',
      rows: [commitRow()],
    });

    expect(matchTransfersMock).toHaveBeenCalledWith('user-1', {
      from: new Date('2026-03-01'),
      to: new Date('2026-03-01'),
    });
  });

  it('does not run transfer matching when nothing was imported', async () => {
    prismaMock.account.findFirst.mockResolvedValue({ id: 'acc-1' });

    await commit({
      accountId: 'acc-1',
      filename: 'march.csv',
      rows: [commitRow({ include: false })],
    });

    expect(matchTransfersMock).not.toHaveBeenCalled();
  });
});

describe('import date handling', () => {
  const row = {
    accountId: 'acc-1',
    date: '2026-03-01',
    amount: 42,
    type: 'EXPENSE' as const,
    payee: 'Coffee Shop',
  };

  it('returns preview dates as UTC midnight', async () => {
    const result = await preview({ accountId: 'acc-1', filename: 'march.csv', rows: [row] });
    expect(result.rows[0].date.toISOString()).toBe('2026-03-01T00:00:00.000Z');
  });

  it('flags a duplicate of a legacy row stored a few hours off midnight', async () => {
    prismaMock.transaction.findMany.mockResolvedValue([
      {
        accountId: 'acc-1',
        date: new Date('2026-03-01T05:00:00Z'),
        amount: 42,
        payee: 'Coffee Shop',
      },
    ]);
    const result = await preview({ accountId: 'acc-1', filename: 'march.csv', rows: [row] });
    expect(result.rows[0].duplicate).toBe(true);
  });

  it('commit dedupes with the same key as preview', async () => {
    prismaMock.account.findFirst.mockResolvedValue({ id: 'acc-1' });
    prismaMock.transaction.findMany.mockResolvedValue([
      { accountId: 'acc-1', date: new Date('2026-03-01'), amount: 42, payee: 'Coffee Shop' },
    ]);
    const parsed = commitImportSchema.parse({
      accountId: 'acc-1',
      filename: 'march.csv',
      // the preview row as the client posts it back: an ISO timestamp
      rows: [{ ...row, date: '2026-03-01T00:00:00.000Z', include: true }],
    });
    const result = await commit(parsed);
    expect(result).toEqual({ batchId: null, imported: 0, skippedDuplicates: 1 });
  });

  it('rejects a raw date that was not normalized to YYYY-MM-DD', async () => {
    await expect(
      preview({
        accountId: 'acc-1',
        filename: 'march.csv',
        rows: [{ ...row, date: '03/01/2026' }],
      }),
    ).rejects.toBeInstanceOf(ServiceValidationError);
    expect(
      previewImportSchema.safeParse({
        accountId: 'acc-1',
        filename: 'march.csv',
        rows: [{ ...row, date: '03/01/2026' }],
      }).success,
    ).toBe(false);
  });
});

describe('adjacent-day duplicates', () => {
  const existingOn = (date: string): void => {
    prismaMock.transaction.findMany.mockResolvedValue([
      { accountId: 'acc-1', date: new Date(date), amount: 42, payee: 'Coffee Shop' },
    ]);
  };
  const previewOn = (date: string): ReturnType<typeof preview> =>
    preview({
      accountId: 'acc-1',
      filename: 'march.csv',
      rows: [{ accountId: 'acc-1', date, amount: 42, type: 'EXPENSE', payee: 'Coffee Shop' }],
    });

  it('flags a matching transaction dated a day earlier or later', async () => {
    existingOn('2026-03-10');
    expect((await previewOn('2026-03-09')).rows[0].duplicate).toBe(true);
    expect((await previewOn('2026-03-11')).rows[0].duplicate).toBe(true);
  });

  it('does not flag a match two days away', async () => {
    existingOn('2026-03-10');
    expect((await previewOn('2026-03-08')).rows[0].duplicate).toBe(false);
    expect((await previewOn('2026-03-12')).rows[0].duplicate).toBe(false);
  });

  it('does not flag a different amount or payee on an adjacent day', async () => {
    prismaMock.transaction.findMany.mockResolvedValue([
      { accountId: 'acc-1', date: new Date('2026-03-10'), amount: 43, payee: 'Coffee Shop' },
      { accountId: 'acc-1', date: new Date('2026-03-10'), amount: 42, payee: 'Tea Shop' },
    ]);
    expect((await previewOn('2026-03-11')).rows[0].duplicate).toBe(false);
  });

  it('skips an adjacent-day match at commit when it was not flagged at preview', async () => {
    prismaMock.account.findFirst.mockResolvedValue({ id: 'acc-1' });
    existingOn('2026-03-10');
    const result = await commit({
      accountId: 'acc-1',
      filename: 'march.csv',
      rows: [commitRow({ date: new Date('2026-03-11') })],
    });
    expect(result).toEqual({ batchId: null, imported: 0, skippedDuplicates: 1 });
  });
});
