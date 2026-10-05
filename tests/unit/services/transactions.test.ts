import { beforeEach, describe, expect, it, vi } from 'vitest';

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    transaction: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    account: { findFirst: vi.fn() },
    category: { findFirst: vi.fn() },
    reimbursementLink: { count: vi.fn() },
  },
}));

vi.mock('@/lib/db/prisma', () => ({ prisma: prismaMock }));

const {
  createTransaction,
  updateTransaction,
  deleteTransaction,
  skipTransaction,
  listTransactions,
} = await import('@/lib/services/transactions');
const { ReimbursementConflictError, ServiceValidationError } =
  await import('@/lib/services/common');

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.account.findFirst.mockResolvedValue({ id: 'acc-1' });
  prismaMock.reimbursementLink.count.mockResolvedValue(0);
});

const baseTx = {
  id: 'tx-1',
  accountId: 'acc-1',
  categoryId: null,
  amount: 50,
  type: 'INCOME' as const,
  date: new Date('2026-03-16'),
  payee: 'Card payment',
  note: null,
  isPayment: true,
  importBatchId: null,
  isTransfer: false,
  transferMatchId: null,
  isReimbursable: false,
  reimbursementExpectedAmount: null,
  reimbursementCompletedAt: null,
  account: { name: 'Visa' },
  category: null,
  importBatch: null,
  reimbursementExpenseLinks: [] as { amount: unknown }[],
  reimbursementIncomeLinks: [] as { amount: unknown }[],
};

/** `updateTransaction`'s existing-row lookup, with the reimbursement fields it now selects. */
const baseExisting = {
  id: 'tx-1',
  accountId: 'acc-1',
  amount: 50,
  type: 'INCOME' as const,
  isTransfer: false,
  isPayment: false,
  isReimbursable: false,
  reimbursementExpectedAmount: null as number | null,
  reimbursementCompletedAt: null as Date | null,
  reimbursementExpenseLinks: [] as { amount: unknown }[],
  reimbursementIncomeLinks: [] as { amount: unknown }[],
};

describe('listTransactions import batch filter', () => {
  it('filters on importBatchId when a batchId is supplied', async () => {
    prismaMock.transaction.findMany.mockResolvedValue([]);

    await listTransactions('user-1', { batchId: 'batch-1' });

    expect(prismaMock.transaction.findMany.mock.calls[0][0].where).toEqual({
      userId: 'user-1',
      accountId: undefined,
      categoryId: undefined,
      importBatchId: 'batch-1',
      date: { gte: undefined, lte: undefined },
    });
  });

  it('leaves importBatchId undefined (never null) when no batchId is supplied', async () => {
    // a `null` here would silently narrow the list to manually-entered rows only
    prismaMock.transaction.findMany.mockResolvedValue([]);

    await listTransactions('user-1', {});

    const where = prismaMock.transaction.findMany.mock.calls[0][0].where;
    expect(where.importBatchId).toBeUndefined();
    expect(where).toEqual({
      userId: 'user-1',
      accountId: undefined,
      categoryId: undefined,
      importBatchId: undefined,
      date: { gte: undefined, lte: undefined },
    });
  });
});

describe('listTransactions import batch mapping', () => {
  it('exposes the batch id and filename for an imported transaction', async () => {
    prismaMock.transaction.findMany.mockResolvedValue([
      {
        ...baseTx,
        importBatchId: 'b1',
        importBatch: { id: 'b1', filename: 'march.csv' },
      },
    ]);

    const [result] = await listTransactions('user-1', {});

    expect(result.importBatchId).toBe('b1');
    expect(result.importBatchFilename).toBe('march.csv');
  });

  it('leaves both batch fields null for a manually entered transaction', async () => {
    prismaMock.transaction.findMany.mockResolvedValue([baseTx]);

    const [result] = await listTransactions('user-1', {});

    expect(result.importBatchId).toBeNull();
    expect(result.importBatchFilename).toBeNull();
  });

  it('still serializes the amount as a fixed-2 string', async () => {
    prismaMock.transaction.findMany.mockResolvedValue([baseTx]);

    const [result] = await listTransactions('user-1', {});

    expect(result.amount).toBe('50.00');
  });
});

describe('createTransaction isPayment', () => {
  it('persists isPayment when flagged as a card payment', async () => {
    prismaMock.transaction.create.mockResolvedValue(baseTx);

    const result = await createTransaction('user-1', {
      accountId: 'acc-1',
      amount: 50,
      type: 'INCOME',
      date: new Date('2026-03-16'),
      payee: 'Card payment',
      isPayment: true,
      isTransfer: false,
      isReimbursable: false,
    });

    expect(prismaMock.transaction.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ isPayment: true }) }),
    );
    expect(result.isPayment).toBe(true);
  });

  it('defaults isPayment to false for ordinary transactions', async () => {
    prismaMock.transaction.create.mockResolvedValue({ ...baseTx, isPayment: false });

    await createTransaction('user-1', {
      accountId: 'acc-1',
      amount: 12,
      type: 'EXPENSE',
      date: new Date('2026-03-16'),
      isPayment: false,
      isTransfer: false,
      isReimbursable: false,
    });

    expect(prismaMock.transaction.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ isPayment: false }) }),
    );
  });
});

describe('updateTransaction isPayment', () => {
  it('passes isPayment through on update', async () => {
    prismaMock.transaction.findFirst.mockResolvedValue({ ...baseExisting });
    prismaMock.transaction.update.mockResolvedValue(baseTx);

    await updateTransaction('user-1', 'tx-1', { isPayment: true });

    expect(prismaMock.transaction.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ isPayment: true }) }),
    );
  });
});

describe('updateTransaction isTransfer', () => {
  it('clears the correlation id when a transfer is un-marked', async () => {
    prismaMock.transaction.findFirst.mockResolvedValue({ ...baseExisting, isTransfer: true });
    prismaMock.transaction.update.mockResolvedValue({ ...baseTx, isTransfer: false });

    const result = await updateTransaction('user-1', 'tx-1', { isTransfer: false });

    expect(prismaMock.transaction.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ isTransfer: false, transferMatchId: null }),
      }),
    );
    expect(result.isTransfer).toBe(false);
  });

  it('leaves the correlation id untouched when marking a transfer by hand', async () => {
    prismaMock.transaction.findFirst.mockResolvedValue({ ...baseExisting });
    prismaMock.transaction.update.mockResolvedValue({ ...baseTx, isTransfer: true });

    await updateTransaction('user-1', 'tx-1', { isTransfer: true });

    expect(prismaMock.transaction.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ isTransfer: true, transferMatchId: undefined }),
      }),
    );
  });
});

describe('skipTransaction', () => {
  it('sets skippedAt to a server-generated timestamp, not a client-supplied one', async () => {
    prismaMock.transaction.findFirst.mockResolvedValue({ id: 'tx-1', accountId: 'acc-1' });
    prismaMock.transaction.update.mockResolvedValue(baseTx);

    await skipTransaction('user-1', 'tx-1');

    expect(prismaMock.transaction.findFirst).toHaveBeenCalledWith({
      where: { id: 'tx-1', userId: 'user-1' },
    });
    expect(prismaMock.transaction.update).toHaveBeenCalledWith({
      where: { id: 'tx-1' },
      data: { skippedAt: expect.any(Date) },
    });
  });

  it('throws when the transaction does not belong to the user', async () => {
    prismaMock.transaction.findFirst.mockResolvedValue(null);

    await expect(skipTransaction('user-1', 'tx-missing')).rejects.toThrow('Transaction not found');
    expect(prismaMock.transaction.update).not.toHaveBeenCalled();
  });
});

describe('deleteTransaction reimbursement guard', () => {
  it('blocks deleting a transaction with an active reimbursement link', async () => {
    prismaMock.transaction.findFirst.mockResolvedValue({ id: 'tx-1', accountId: 'acc-1' });
    prismaMock.reimbursementLink.count.mockResolvedValue(1);

    await expect(deleteTransaction('user-1', 'tx-1')).rejects.toThrow(ReimbursementConflictError);
    expect(prismaMock.transaction.delete).not.toHaveBeenCalled();
  });

  it('deletes normally when there are no active links', async () => {
    prismaMock.transaction.findFirst.mockResolvedValue({ id: 'tx-1', accountId: 'acc-1' });
    prismaMock.reimbursementLink.count.mockResolvedValue(0);

    await deleteTransaction('user-1', 'tx-1');

    expect(prismaMock.transaction.delete).toHaveBeenCalledWith({ where: { id: 'tx-1' } });
  });
});

describe('updateTransaction reimbursement blocking rules', () => {
  it('1: blocks changing type off EXPENSE while the row has an active expense-side link', async () => {
    prismaMock.transaction.findFirst.mockResolvedValue({
      ...baseExisting,
      type: 'EXPENSE',
      isReimbursable: true,
      reimbursementExpenseLinks: [{ amount: 10 }],
    });

    await expect(updateTransaction('user-1', 'tx-1', { type: 'INCOME' })).rejects.toThrow(
      ReimbursementConflictError,
    );
    expect(prismaMock.transaction.update).not.toHaveBeenCalled();
  });

  it('2: blocks changing type off INCOME while the row has an active income-side link', async () => {
    prismaMock.transaction.findFirst.mockResolvedValue({
      ...baseExisting,
      type: 'INCOME',
      reimbursementIncomeLinks: [{ amount: 10 }],
    });

    await expect(updateTransaction('user-1', 'tx-1', { type: 'EXPENSE' })).rejects.toThrow(
      ReimbursementConflictError,
    );
  });

  it('3: blocks setting isReimbursable true together with isTransfer true', async () => {
    prismaMock.transaction.findFirst.mockResolvedValue({ ...baseExisting, type: 'EXPENSE' });

    await expect(
      updateTransaction('user-1', 'tx-1', {
        isReimbursable: true,
        reimbursementExpectedAmount: 10,
        isTransfer: true,
      }),
    ).rejects.toThrow(ServiceValidationError);
  });

  it('4: blocks setting isReimbursable true together with isPayment true', async () => {
    prismaMock.transaction.findFirst.mockResolvedValue({ ...baseExisting, type: 'EXPENSE' });

    await expect(
      updateTransaction('user-1', 'tx-1', {
        isReimbursable: true,
        reimbursementExpectedAmount: 10,
        isPayment: true,
      }),
    ).rejects.toThrow(ServiceValidationError);
  });

  it('5: blocks marking an income-side-linked row as a transfer', async () => {
    prismaMock.transaction.findFirst.mockResolvedValue({
      ...baseExisting,
      type: 'INCOME',
      reimbursementIncomeLinks: [{ amount: 10 }],
    });

    await expect(updateTransaction('user-1', 'tx-1', { isTransfer: true })).rejects.toThrow(
      ReimbursementConflictError,
    );
  });

  it('5b: blocks marking an income-side-linked row as a card payment', async () => {
    prismaMock.transaction.findFirst.mockResolvedValue({
      ...baseExisting,
      type: 'INCOME',
      reimbursementIncomeLinks: [{ amount: 10 }],
    });

    await expect(updateTransaction('user-1', 'tx-1', { isPayment: true })).rejects.toThrow(
      ReimbursementConflictError,
    );
  });

  it('6: blocks un-marking isReimbursable while links exist', async () => {
    prismaMock.transaction.findFirst.mockResolvedValue({
      ...baseExisting,
      type: 'EXPENSE',
      isReimbursable: true,
      reimbursementExpectedAmount: 20,
      reimbursementExpenseLinks: [{ amount: 10 }],
    });

    await expect(updateTransaction('user-1', 'tx-1', { isReimbursable: false })).rejects.toThrow(
      ReimbursementConflictError,
    );
  });

  it('6b: allows un-marking isReimbursable when no links exist', async () => {
    prismaMock.transaction.findFirst.mockResolvedValue({
      ...baseExisting,
      type: 'EXPENSE',
      isReimbursable: true,
      reimbursementExpectedAmount: 20,
    });
    prismaMock.transaction.update.mockResolvedValue({ ...baseTx, type: 'EXPENSE' });

    await updateTransaction('user-1', 'tx-1', { isReimbursable: false });

    expect(prismaMock.transaction.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          isReimbursable: false,
          reimbursementExpectedAmount: null,
        }),
      }),
    );
  });

  it('7: blocks an expected amount greater than the expense amount', async () => {
    prismaMock.transaction.findFirst.mockResolvedValue({
      ...baseExisting,
      type: 'EXPENSE',
      amount: 10,
    });

    await expect(
      updateTransaction('user-1', 'tx-1', {
        isReimbursable: true,
        reimbursementExpectedAmount: 20,
      }),
    ).rejects.toThrow(ServiceValidationError);
  });

  it('7b: allows an expected amount equal to the expense amount', async () => {
    prismaMock.transaction.findFirst.mockResolvedValue({
      ...baseExisting,
      type: 'EXPENSE',
      amount: 10,
    });
    prismaMock.transaction.update.mockResolvedValue({ ...baseTx, type: 'EXPENSE' });

    await updateTransaction('user-1', 'tx-1', {
      isReimbursable: true,
      reimbursementExpectedAmount: 10,
    });

    expect(prismaMock.transaction.update).toHaveBeenCalled();
  });

  it('8: blocks reducing the expected amount below the amount already linked', async () => {
    prismaMock.transaction.findFirst.mockResolvedValue({
      ...baseExisting,
      type: 'EXPENSE',
      amount: 50,
      isReimbursable: true,
      reimbursementExpectedAmount: 30,
      reimbursementExpenseLinks: [{ amount: 20 }],
    });

    await expect(
      updateTransaction('user-1', 'tx-1', { reimbursementExpectedAmount: 10 }),
    ).rejects.toThrow(ReimbursementConflictError);
  });

  it('8b: allows reducing the expected amount to exactly the amount already linked', async () => {
    prismaMock.transaction.findFirst.mockResolvedValue({
      ...baseExisting,
      type: 'EXPENSE',
      amount: 50,
      isReimbursable: true,
      reimbursementExpectedAmount: 30,
      reimbursementExpenseLinks: [{ amount: 20 }],
    });
    prismaMock.transaction.update.mockResolvedValue({ ...baseTx, type: 'EXPENSE' });

    await updateTransaction('user-1', 'tx-1', { reimbursementExpectedAmount: 20 });

    expect(prismaMock.transaction.update).toHaveBeenCalled();
  });

  it('9: blocks reducing an income amount below the sum of its own active link amounts', async () => {
    prismaMock.transaction.findFirst.mockResolvedValue({
      ...baseExisting,
      type: 'INCOME',
      amount: 50,
      reimbursementIncomeLinks: [{ amount: 30 }],
    });

    await expect(updateTransaction('user-1', 'tx-1', { amount: 20 })).rejects.toThrow(
      ReimbursementConflictError,
    );
  });

  it('9b: allows reducing an income amount to exactly its linked total', async () => {
    prismaMock.transaction.findFirst.mockResolvedValue({
      ...baseExisting,
      type: 'INCOME',
      amount: 50,
      reimbursementIncomeLinks: [{ amount: 30 }],
    });
    prismaMock.transaction.update.mockResolvedValue(baseTx);

    await updateTransaction('user-1', 'tx-1', { amount: 30 });

    expect(prismaMock.transaction.update).toHaveBeenCalled();
  });

  it('10: blocks marking fully reimbursed when the row is not reimbursable', async () => {
    prismaMock.transaction.findFirst.mockResolvedValue({ ...baseExisting, type: 'EXPENSE' });

    await expect(
      updateTransaction('user-1', 'tx-1', { reimbursementCompleted: true }),
    ).rejects.toThrow(ServiceValidationError);
  });

  it('10b: allows marking fully reimbursed on a reimbursable expense', async () => {
    prismaMock.transaction.findFirst.mockResolvedValue({
      ...baseExisting,
      type: 'EXPENSE',
      isReimbursable: true,
      reimbursementExpectedAmount: 20,
    });
    prismaMock.transaction.update.mockResolvedValue({ ...baseTx, type: 'EXPENSE' });

    await updateTransaction('user-1', 'tx-1', { reimbursementCompleted: true });

    expect(prismaMock.transaction.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ reimbursementCompletedAt: expect.any(Date) }),
      }),
    );
  });

  it('preserves the original completedAt timestamp on a repeat save', async () => {
    const existingCompletedAt = new Date('2026-01-01');
    prismaMock.transaction.findFirst.mockResolvedValue({
      ...baseExisting,
      type: 'EXPENSE',
      isReimbursable: true,
      reimbursementExpectedAmount: 20,
      reimbursementCompletedAt: existingCompletedAt,
    });
    prismaMock.transaction.update.mockResolvedValue({ ...baseTx, type: 'EXPENSE' });

    await updateTransaction('user-1', 'tx-1', { reimbursementCompleted: true });

    expect(prismaMock.transaction.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ reimbursementCompletedAt: existingCompletedAt }),
      }),
    );
  });

  it('clears completedAt when explicitly un-marked', async () => {
    prismaMock.transaction.findFirst.mockResolvedValue({
      ...baseExisting,
      type: 'EXPENSE',
      isReimbursable: true,
      reimbursementExpectedAmount: 20,
      reimbursementCompletedAt: new Date('2026-01-01'),
    });
    prismaMock.transaction.update.mockResolvedValue({ ...baseTx, type: 'EXPENSE' });

    await updateTransaction('user-1', 'tx-1', { reimbursementCompleted: false });

    expect(prismaMock.transaction.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ reimbursementCompletedAt: null }),
      }),
    );
  });
});

describe('FrontendTransaction reimbursement fields', () => {
  it('defaults every reimbursement field for an ordinary transaction', async () => {
    prismaMock.transaction.findMany.mockResolvedValue([baseTx]);

    const [result] = await listTransactions('user-1', {});

    expect(result.isReimbursable).toBe(false);
    expect(result.reimbursementExpectedAmount).toBeNull();
    expect(result.reimbursementLinkedTotal).toBe('0.00');
    expect(result.reimbursementOutstanding).toBe('0.00');
    expect(result.reimbursementStatus).toBeNull();
    expect(result.reimbursementCompletedManually).toBe(false);
    expect(result.isReimbursementIncome).toBe(false);
    expect(result.reimbursementIncomeLinkedTotal).toBe('0.00');
    expect(result).not.toHaveProperty('reimbursementExpenseLinks');
    expect(result).not.toHaveProperty('reimbursementIncomeLinks');
  });

  it('reports PARTIAL status and fixed-2 totals for a partially linked expense', async () => {
    prismaMock.transaction.findMany.mockResolvedValue([
      {
        ...baseTx,
        type: 'EXPENSE',
        amount: 100,
        isReimbursable: true,
        reimbursementExpectedAmount: 60,
        reimbursementExpenseLinks: [{ amount: 25 }],
      },
    ]);

    const [result] = await listTransactions('user-1', {});

    expect(result.reimbursementStatus).toBe('PARTIAL');
    expect(result.reimbursementExpectedAmount).toBe('60.00');
    expect(result.reimbursementLinkedTotal).toBe('25.00');
    expect(result.reimbursementOutstanding).toBe('35.00');
  });

  it('reports COMPLETE and completedManually for a manually-completed expense with no links', async () => {
    prismaMock.transaction.findMany.mockResolvedValue([
      {
        ...baseTx,
        type: 'EXPENSE',
        amount: 100,
        isReimbursable: true,
        reimbursementExpectedAmount: 60,
        reimbursementCompletedAt: new Date('2026-01-01'),
      },
    ]);

    const [result] = await listTransactions('user-1', {});

    expect(result.reimbursementStatus).toBe('COMPLETE');
    expect(result.reimbursementCompletedManually).toBe(true);
  });

  it('marks an income row linked as a reimbursement, with its own linked total', async () => {
    prismaMock.transaction.findMany.mockResolvedValue([
      {
        ...baseTx,
        type: 'INCOME',
        reimbursementIncomeLinks: [{ amount: 15 }],
      },
    ]);

    const [result] = await listTransactions('user-1', {});

    expect(result.isReimbursementIncome).toBe(true);
    expect(result.reimbursementIncomeLinkedTotal).toBe('15.00');
    expect(result.isReimbursable).toBe(false);
    expect(result.reimbursementExpectedAmount).toBeNull();
  });
});

describe('transaction spreading', () => {
  const spreadExpenseTx = {
    ...baseTx,
    type: 'EXPENSE' as const,
    isPayment: false,
    amount: 3600,
    date: new Date('2026-06-15'),
    spreadStartMonth: 202601,
    spreadMonths: 12,
  };
  const existingExpense = {
    ...baseExisting,
    type: 'EXPENSE' as const,
    amount: 3600,
    date: new Date('2026-06-15'),
    spreadStartMonth: null as number | null,
    spreadMonths: null as number | null,
  };

  it('writes all three spread columns on create, deriving the end month', async () => {
    prismaMock.transaction.create.mockResolvedValue(spreadExpenseTx);

    const result = await createTransaction('user-1', {
      accountId: 'acc-1',
      amount: 3600,
      type: 'EXPENSE',
      date: new Date('2026-06-15'),
      isPayment: false,
      isTransfer: false,
      isReimbursable: false,
      spreadStartMonth: 202601,
      spreadMonths: 12,
    });

    expect(prismaMock.transaction.create.mock.calls[0][0].data).toMatchObject({
      spreadStartMonth: 202601,
      spreadMonths: 12,
      spreadEndMonth: 202612,
    });
    expect(result).toMatchObject({
      spreadStartMonth: 202601,
      spreadMonths: 12,
      spreadMonthlyAmount: '300.00',
    });
  });

  it('writes all three as null on create when not spread', async () => {
    prismaMock.transaction.create.mockResolvedValue({ ...baseTx });

    const result = await createTransaction('user-1', {
      accountId: 'acc-1',
      amount: 12,
      type: 'EXPENSE',
      date: new Date('2026-03-16'),
      isPayment: false,
      isTransfer: false,
      isReimbursable: false,
    });

    expect(prismaMock.transaction.create.mock.calls[0][0].data).toMatchObject({
      spreadStartMonth: null,
      spreadMonths: null,
      spreadEndMonth: null,
    });
    expect(result.spreadMonthlyAmount).toBeNull();
  });

  it('sets a spread on update', async () => {
    prismaMock.transaction.findFirst.mockResolvedValue({ ...existingExpense });
    prismaMock.transaction.update.mockResolvedValue(spreadExpenseTx);

    await updateTransaction('user-1', 'tx-1', { spreadStartMonth: 202607, spreadMonths: 12 });

    expect(prismaMock.transaction.update.mock.calls[0][0].data).toMatchObject({
      spreadStartMonth: 202607,
      spreadMonths: 12,
      spreadEndMonth: 202706,
    });
  });

  it('clears all three columns when the spread is turned off', async () => {
    prismaMock.transaction.findFirst.mockResolvedValue({
      ...existingExpense,
      spreadStartMonth: 202601,
      spreadMonths: 12,
    });
    prismaMock.transaction.update.mockResolvedValue({ ...baseTx });

    await updateTransaction('user-1', 'tx-1', { spreadStartMonth: null, spreadMonths: null });

    expect(prismaMock.transaction.update.mock.calls[0][0].data).toMatchObject({
      spreadStartMonth: null,
      spreadMonths: null,
      spreadEndMonth: null,
    });
  });

  it('leaves the spread columns untouched on an unrelated edit', async () => {
    prismaMock.transaction.findFirst.mockResolvedValue({
      ...existingExpense,
      spreadStartMonth: 202601,
      spreadMonths: 12,
    });
    prismaMock.transaction.update.mockResolvedValue(spreadExpenseTx);

    await updateTransaction('user-1', 'tx-1', { payee: 'City of Toronto' });

    const data = prismaMock.transaction.update.mock.calls[0][0].data;
    expect(data).not.toHaveProperty('spreadStartMonth');
    expect(data).not.toHaveProperty('spreadEndMonth');
  });

  it('rejects turning a spread expense into income', async () => {
    prismaMock.transaction.findFirst.mockResolvedValue({
      ...existingExpense,
      spreadStartMonth: 202601,
      spreadMonths: 12,
    });

    await expect(updateTransaction('user-1', 'tx-1', { type: 'INCOME' })).rejects.toBeInstanceOf(
      ServiceValidationError,
    );
    expect(prismaMock.transaction.update).not.toHaveBeenCalled();
  });

  it('rejects marking a spread expense reimbursable, or a transfer', async () => {
    const spreadExisting = { ...existingExpense, spreadStartMonth: 202601, spreadMonths: 12 };
    prismaMock.transaction.findFirst.mockResolvedValue(spreadExisting);
    await expect(
      updateTransaction('user-1', 'tx-1', {
        isReimbursable: true,
        reimbursementExpectedAmount: 100,
      }),
    ).rejects.toBeInstanceOf(ServiceValidationError);

    prismaMock.transaction.findFirst.mockResolvedValue(spreadExisting);
    await expect(updateTransaction('user-1', 'tx-1', { isTransfer: true })).rejects.toBeInstanceOf(
      ServiceValidationError,
    );
  });

  it('rejects spreading an existing reimbursable expense', async () => {
    prismaMock.transaction.findFirst.mockResolvedValue({
      ...existingExpense,
      isReimbursable: true,
      reimbursementExpectedAmount: 100,
    });

    await expect(
      updateTransaction('user-1', 'tx-1', { spreadStartMonth: 202601, spreadMonths: 12 }),
    ).rejects.toBeInstanceOf(ServiceValidationError);
  });

  it('rejects moving the date so the spread start is over 24 months away', async () => {
    prismaMock.transaction.findFirst.mockResolvedValue({
      ...existingExpense,
      spreadStartMonth: 202601,
      spreadMonths: 12,
    });

    await expect(
      updateTransaction('user-1', 'tx-1', { date: new Date('2028-06-15') }),
    ).rejects.toBeInstanceOf(ServiceValidationError);
  });
});
