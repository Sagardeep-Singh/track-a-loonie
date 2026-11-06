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

/** what updateAccount's findFirst returns: the row plus its counts and latest update */
const existingAccount = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'acc-1',
  type: 'CHECKING',
  startingBalance: 0,
  tracksBalance: false,
  _count: { transactions: 0, balanceUpdates: 0 },
  balanceUpdates: [],
  ...overrides,
});

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
        balanceUpdatedAt: null,
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
      tracksBalance: false,
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
      tracksBalance: false,
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
    prismaMock.account.findFirst.mockResolvedValue(existingAccount({ type: 'CREDIT_CARD' }));
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
    prismaMock.account.findFirst.mockResolvedValue(existingAccount({ type: 'CREDIT_CARD' }));
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

describe('balance-tracked accounts', () => {
  const createdRow = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: 'acc-9',
    name: 'TFSA',
    type: 'TFSA',
    startingBalance: 5000,
    statementDay: null,
    onBudget: false,
    tracksBalance: true,
    createdAt: new Date('2026-01-01'),
    transactions: [],
    importBatches: [],
    balanceUpdates: [],
    ...overrides,
  });

  it('reports the latest balance update as the balance of a tracked account', async () => {
    prismaMock.account.findMany.mockResolvedValue([
      createdRow({
        balanceUpdates: [{ balance: 6250.5, date: new Date('2026-10-01T00:00:00.000Z') }],
      }),
    ]);

    const [account] = await listAccounts('user-1');

    expect(account).toMatchObject({
      balance: '6250.50',
      tracksBalance: true,
      balanceUpdatedAt: '2026-10-01T00:00:00.000Z',
      transactionCount: 0,
    });
  });

  it('falls back to the starting balance when a tracked account has no updates', async () => {
    prismaMock.account.findMany.mockResolvedValue([createdRow()]);

    const [account] = await listAccounts('user-1');

    expect(account).toMatchObject({ balance: '5000.00', balanceUpdatedAt: null });
  });

  it('ignores balance updates on an untracked account', async () => {
    prismaMock.account.findMany.mockResolvedValue([
      createdRow({
        tracksBalance: false,
        balanceUpdates: [{ balance: 1, date: new Date('2026-10-01') }],
        transactions: [{ amount: 100, type: 'INCOME' }],
      }),
    ]);

    const [account] = await listAccounts('user-1');

    expect(account).toMatchObject({ balance: '5100.00', balanceUpdatedAt: null });
  });

  it('defaults tracking on for savings, registered and investment types only', async () => {
    prismaMock.account.create.mockResolvedValue(createdRow());

    for (const type of ['SAVINGS', 'TFSA', 'RRSP', 'INVESTMENT', 'CHECKING', 'CREDIT_CARD']) {
      await createAccount('user-1', { name: type, type: type as 'TFSA', startingBalance: 0 });
    }

    const tracked = prismaMock.account.create.mock.calls.map(
      (call: unknown[]) => (call[0] as { data: { tracksBalance: boolean } }).data.tracksBalance,
    );
    expect(tracked).toEqual([true, true, true, true, false, false]);
  });

  it('forces a tracked account off-budget and logs its starting balance as the first update', async () => {
    prismaMock.account.create.mockResolvedValue(createdRow());
    const date = new Date('2026-11-05T00:00:00.000Z');

    await createAccount('user-1', {
      name: 'Checking by balance',
      type: 'CHECKING',
      startingBalance: 5000,
      onBudget: true,
      tracksBalance: true,
      startingBalanceDate: date,
    });

    const { data } = prismaMock.account.create.mock.calls[0]![0] as {
      data: Record<string, unknown>;
    };
    expect(data.onBudget).toBe(false);
    expect(data.balanceUpdates).toEqual({
      create: { userId: 'user-1', balance: 5000, date },
    });
  });

  it('does not log a first update for a transaction account', async () => {
    prismaMock.account.create.mockResolvedValue(createdRow({ tracksBalance: false }));

    await createAccount('user-1', { name: 'Chq', type: 'CHECKING', startingBalance: 10 });

    const { data } = prismaMock.account.create.mock.calls[0]![0] as {
      data: Record<string, unknown>;
    };
    expect(data.balanceUpdates).toBeUndefined();
  });

  it('refuses to start tracking an account that has transactions', async () => {
    prismaMock.account.findFirst.mockResolvedValue(
      existingAccount({ _count: { transactions: 3, balanceUpdates: 0 } }),
    );

    await expect(updateAccount('user-1', 'acc-1', { tracksBalance: true })).rejects.toThrow(
      /transactions before tracking/,
    );
    expect(prismaMock.account.update).not.toHaveBeenCalled();
  });

  it('refuses to put a tracked account on-budget', async () => {
    prismaMock.account.findFirst.mockResolvedValue(existingAccount({ tracksBalance: true }));

    await expect(updateAccount('user-1', 'acc-1', { onBudget: true })).rejects.toThrow(
      /always off-budget/,
    );
  });

  it('logs the current balance as the first update when tracking starts', async () => {
    prismaMock.account.findFirst.mockResolvedValue(existingAccount({ startingBalance: 1200 }));
    prismaMock.account.update.mockResolvedValue(createdRow());
    const date = new Date('2026-11-05T00:00:00.000Z');

    await updateAccount('user-1', 'acc-1', { tracksBalance: true, startingBalanceDate: date });

    const { data } = prismaMock.account.update.mock.calls[0]![0] as {
      data: Record<string, unknown>;
    };
    expect(data).toMatchObject({ tracksBalance: true, onBudget: false });
    expect(data).not.toHaveProperty('startingBalanceDate');
    expect(data.balanceUpdates).toEqual({ create: { userId: 'user-1', balance: 1200, date } });
  });

  it('keeps the old updates instead of logging another when tracking is re-enabled', async () => {
    prismaMock.account.findFirst.mockResolvedValue(
      existingAccount({ _count: { transactions: 0, balanceUpdates: 2 } }),
    );
    prismaMock.account.update.mockResolvedValue(createdRow());

    await updateAccount('user-1', 'acc-1', { tracksBalance: true });

    const { data } = prismaMock.account.update.mock.calls[0]![0] as {
      data: Record<string, unknown>;
    };
    expect(data.balanceUpdates).toBeUndefined();
  });

  it('copies the tracked balance into the starting balance when tracking stops', async () => {
    prismaMock.account.findFirst.mockResolvedValue(
      existingAccount({
        tracksBalance: true,
        balanceUpdates: [{ balance: 7300, date: new Date('2026-10-01') }],
      }),
    );
    prismaMock.account.update.mockResolvedValue(createdRow({ tracksBalance: false }));

    await updateAccount('user-1', 'acc-1', { tracksBalance: false });

    expect(prismaMock.account.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ startingBalance: 7300 }) }),
    );
  });

  it('uses an explicit starting balance over the tracked one when tracking stops', async () => {
    prismaMock.account.findFirst.mockResolvedValue(
      existingAccount({
        tracksBalance: true,
        balanceUpdates: [{ balance: 7300, date: new Date('2026-10-01') }],
      }),
    );
    prismaMock.account.update.mockResolvedValue(createdRow({ tracksBalance: false }));

    await updateAccount('user-1', 'acc-1', { tracksBalance: false, startingBalance: 7000 });

    expect(prismaMock.account.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ startingBalance: 7000 }) }),
    );
  });
});
