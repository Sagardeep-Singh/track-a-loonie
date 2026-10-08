import { beforeEach, describe, expect, it, vi } from 'vitest';

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    account: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    reimbursementLink: { count: vi.fn() },
  },
}));

vi.mock('@/lib/db/prisma', () => ({ prisma: prismaMock }));

const { createAccount, deleteAccount, listAccounts, updateAccount } =
  await import('@/lib/services/accounts');
const { ReimbursementConflictError, ServiceValidationError } =
  await import('@/lib/services/common');

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.reimbursementLink.count.mockResolvedValue(0);
});

describe('listAccounts', () => {
  it('derives balance from starting balance plus signed transaction amounts', async () => {
    prismaMock.account.findMany.mockResolvedValue([
      {
        id: 'acc-1',
        name: 'Checking',
        type: 'CHECKING',
        startingBalance: 100,
        createdAt: new Date('2026-01-01'),
        transactions: [
          { amount: 50, type: 'INCOME' },
          { amount: 20, type: 'EXPENSE' },
        ],
        importBatches: [],
      },
    ]);

    const result = await listAccounts('user-1');

    expect(result).toEqual([
      {
        id: 'acc-1',
        name: 'Checking',
        type: 'CHECKING',
        startingBalance: 100,
        createdAt: '2026-01-01T00:00:00.000Z',
        balance: '130.00',
        transactionCount: 2,
        lastImportAt: null,
      },
    ]);
  });
});

describe('createAccount', () => {
  it('creates an account scoped to the user', async () => {
    prismaMock.account.create.mockResolvedValue({
      id: 'acc-2',
      name: 'Savings',
      type: 'SAVINGS',
      startingBalance: 0,
      createdAt: new Date('2026-01-01'),
      transactions: [],
      importBatches: [],
    });

    const result = await createAccount('user-1', {
      name: 'Savings',
      type: 'SAVINGS',
      startingBalance: 0,
    });

    expect(prismaMock.account.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ userId: 'user-1' }) }),
    );
    expect(result.balance).toBe('0.00');
  });

  it('puts savings off-budget and everything else on-budget by default', async () => {
    prismaMock.account.create.mockResolvedValue({
      id: 'acc-3',
      name: 'x',
      type: 'CHECKING',
      startingBalance: 0,
      onBudget: true,
      createdAt: new Date('2026-01-01'),
      transactions: [],
      importBatches: [],
    });

    await createAccount('user-1', { name: 'Savings', type: 'SAVINGS', startingBalance: 0 });
    await createAccount('user-1', { name: 'Visa', type: 'CREDIT_CARD', startingBalance: 0 });
    await createAccount('user-1', {
      name: 'Rainy day',
      type: 'SAVINGS',
      startingBalance: 0,
      onBudget: true,
    });

    const flags = prismaMock.account.create.mock.calls.map(
      (call: unknown[]) => (call[0] as { data: { onBudget: boolean } }).data.onBudget,
    );
    expect(flags).toEqual([false, true, true]);
  });

  it('puts registered and investment accounts off-budget and a line of credit on-budget', async () => {
    prismaMock.account.create.mockResolvedValue({
      id: 'acc-4',
      name: 'x',
      type: 'TFSA',
      startingBalance: 0,
      onBudget: false,
      createdAt: new Date('2026-01-01'),
      transactions: [],
      importBatches: [],
    });

    await createAccount('user-1', { name: 'RRSP', type: 'RRSP', startingBalance: 0 });
    await createAccount('user-1', { name: 'TFSA', type: 'TFSA', startingBalance: 0 });
    await createAccount('user-1', { name: 'Brokerage', type: 'INVESTMENT', startingBalance: 0 });
    await createAccount('user-1', { name: 'HELOC', type: 'LINE_OF_CREDIT', startingBalance: 0 });
    await createAccount('user-1', {
      name: 'Spending TFSA',
      type: 'TFSA',
      startingBalance: 0,
      onBudget: true,
    });

    const flags = prismaMock.account.create.mock.calls.map(
      (call: unknown[]) => (call[0] as { data: { onBudget: boolean } }).data.onBudget,
    );
    expect(flags).toEqual([false, false, false, true, true]);
  });

  it('drops statementDay for a line of credit', async () => {
    prismaMock.account.create.mockResolvedValue({
      id: 'acc-5',
      name: 'LOC',
      type: 'LINE_OF_CREDIT',
      startingBalance: 0,
      createdAt: new Date('2026-01-01'),
      transactions: [],
      importBatches: [],
    });

    await createAccount('user-1', {
      name: 'LOC',
      type: 'LINE_OF_CREDIT',
      startingBalance: 0,
      statementDay: 15,
    });

    expect(prismaMock.account.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ statementDay: null }) }),
    );
  });
});

describe('updateAccount / deleteAccount', () => {
  it('throws ServiceValidationError when the account does not belong to the user', async () => {
    prismaMock.account.findFirst.mockResolvedValue(null);

    await expect(updateAccount('user-1', 'acc-x', { name: 'x' })).rejects.toThrow(
      ServiceValidationError,
    );
    await expect(deleteAccount('user-1', 'acc-x')).rejects.toThrow(ServiceValidationError);
  });
});

describe('deleteAccount reimbursement guard', () => {
  it('blocks deleting an account whose transactions have an active reimbursement link', async () => {
    prismaMock.account.findFirst.mockResolvedValue({
      id: 'acc-1',
      transactions: [{ id: 'tx-1' }, { id: 'tx-2' }],
    });
    prismaMock.reimbursementLink.count.mockResolvedValue(1);

    await expect(deleteAccount('user-1', 'acc-1')).rejects.toThrow(ReimbursementConflictError);
    expect(prismaMock.account.delete).not.toHaveBeenCalled();
  });

  it('deletes normally when none of its transactions have an active link', async () => {
    prismaMock.account.findFirst.mockResolvedValue({
      id: 'acc-1',
      transactions: [{ id: 'tx-1' }],
    });
    prismaMock.reimbursementLink.count.mockResolvedValue(0);

    await deleteAccount('user-1', 'acc-1');

    expect(prismaMock.account.delete).toHaveBeenCalledWith({ where: { id: 'acc-1' } });
  });

  it('deletes normally when the account has no transactions at all', async () => {
    prismaMock.account.findFirst.mockResolvedValue({ id: 'acc-1', transactions: [] });

    await deleteAccount('user-1', 'acc-1');

    expect(prismaMock.reimbursementLink.count).not.toHaveBeenCalled();
    expect(prismaMock.account.delete).toHaveBeenCalledWith({ where: { id: 'acc-1' } });
  });
});

describe('updateAccount statementDay', () => {
  it('rejects statementDay when the resulting type is not CREDIT_CARD', async () => {
    prismaMock.account.findFirst.mockResolvedValue({ id: 'acc-1', type: 'SAVINGS' });

    await expect(updateAccount('user-1', 'acc-1', { statementDay: 15 })).rejects.toThrow(
      ServiceValidationError,
    );
    expect(prismaMock.account.update).not.toHaveBeenCalled();
  });

  it('rejects statementDay on a line of credit', async () => {
    prismaMock.account.findFirst.mockResolvedValue({ id: 'acc-1', type: 'LINE_OF_CREDIT' });

    await expect(updateAccount('user-1', 'acc-1', { statementDay: 15 })).rejects.toThrow(
      ServiceValidationError,
    );
    expect(prismaMock.account.update).not.toHaveBeenCalled();
  });

  it('clears statementDay when the type changes away from CREDIT_CARD', async () => {
    prismaMock.account.findFirst.mockResolvedValue({ id: 'acc-1', type: 'CREDIT_CARD' });
    prismaMock.account.update.mockResolvedValue({
      id: 'acc-1',
      name: 'Old Card',
      type: 'CASH',
      startingBalance: 0,
      statementDay: null,
      createdAt: new Date('2026-01-01'),
      transactions: [],
      importBatches: [],
    });

    await updateAccount('user-1', 'acc-1', { type: 'CASH' });

    expect(prismaMock.account.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ statementDay: null }) }),
    );
  });

  it('persists statementDay when the account is (or becomes) a CREDIT_CARD', async () => {
    prismaMock.account.findFirst.mockResolvedValue({ id: 'acc-1', type: 'CREDIT_CARD' });
    prismaMock.account.update.mockResolvedValue({
      id: 'acc-1',
      name: 'Visa',
      type: 'CREDIT_CARD',
      startingBalance: 0,
      statementDay: 20,
      createdAt: new Date('2026-01-01'),
      transactions: [],
      importBatches: [],
    });

    const result = await updateAccount('user-1', 'acc-1', { statementDay: 20 });

    expect(prismaMock.account.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ statementDay: 20 }) }),
    );
    expect(result.statementDay).toBe(20);
  });
});
