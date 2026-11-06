import { beforeEach, describe, expect, it, vi } from 'vitest';

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    account: { findFirst: vi.fn(), findMany: vi.fn() },
    accountBalanceUpdate: { create: vi.fn(), deleteMany: vi.fn() },
  },
}));

vi.mock('@/lib/db/prisma', () => ({ prisma: prismaMock }));

const { createBalanceUpdate, deleteBalanceUpdate, getAccountHistory, getNetWorthHistory } =
  await import('@/lib/services/accountBalances');
const { ServiceValidationError } = await import('@/lib/services/common');

const day = (key: string): Date => new Date(`${key}T00:00:00.000Z`);
const NOW = day('2026-11-06');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('createBalanceUpdate', () => {
  const input = { balance: 6200, date: day('2026-11-01'), note: 'Statement' };

  it('rejects an account the user does not own', async () => {
    prismaMock.account.findFirst.mockResolvedValue(null);

    await expect(createBalanceUpdate('user-1', 'acc-x', input)).rejects.toThrow(
      'Account not found',
    );
    expect(prismaMock.account.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'acc-x', userId: 'user-1' } }),
    );
  });

  it('rejects an account whose balance comes from transactions', async () => {
    prismaMock.account.findFirst.mockResolvedValue({ tracksBalance: false });

    await expect(createBalanceUpdate('user-1', 'acc-1', input)).rejects.toThrow(
      ServiceValidationError,
    );
    expect(prismaMock.accountBalanceUpdate.create).not.toHaveBeenCalled();
  });

  it('stores the balance scoped to the user and returns a plain object', async () => {
    prismaMock.account.findFirst.mockResolvedValue({ tracksBalance: true });
    prismaMock.accountBalanceUpdate.create.mockResolvedValue({
      id: 'bu-1',
      userId: 'user-1',
      accountId: 'acc-1',
      balance: '6200',
      date: input.date,
      note: 'Statement',
      createdAt: NOW,
    });

    const result = await createBalanceUpdate('user-1', 'acc-1', input);

    expect(prismaMock.accountBalanceUpdate.create).toHaveBeenCalledWith({
      data: {
        userId: 'user-1',
        accountId: 'acc-1',
        balance: 6200,
        date: input.date,
        note: 'Statement',
      },
    });
    expect(result).toEqual({
      id: 'bu-1',
      balance: '6200.00',
      date: '2026-11-01T00:00:00.000Z',
      note: 'Statement',
      change: null,
    });
  });

  it('stores a blank note as null', async () => {
    prismaMock.account.findFirst.mockResolvedValue({ tracksBalance: true });
    prismaMock.accountBalanceUpdate.create.mockResolvedValue({
      id: 'bu-1',
      balance: 1,
      date: input.date,
      note: null,
    });

    await createBalanceUpdate('user-1', 'acc-1', { ...input, note: '' });

    expect(prismaMock.accountBalanceUpdate.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ note: null }),
    });
  });
});

describe('deleteBalanceUpdate', () => {
  it("only deletes the user's own update on that account", async () => {
    prismaMock.accountBalanceUpdate.deleteMany.mockResolvedValue({ count: 1 });

    await deleteBalanceUpdate('user-1', 'acc-1', 'bu-1');

    expect(prismaMock.accountBalanceUpdate.deleteMany).toHaveBeenCalledWith({
      where: { id: 'bu-1', accountId: 'acc-1', userId: 'user-1' },
    });
  });

  it('throws when nothing matched', async () => {
    prismaMock.accountBalanceUpdate.deleteMany.mockResolvedValue({ count: 0 });

    await expect(deleteBalanceUpdate('user-1', 'acc-1', 'bu-x')).rejects.toThrow(
      'Balance update not found',
    );
  });
});

describe('getAccountHistory', () => {
  it('throws for an account the user does not own', async () => {
    prismaMock.account.findFirst.mockResolvedValue(null);

    await expect(getAccountHistory('user-1', 'acc-x', 6, NOW)).rejects.toThrow('Account not found');
  });

  it('derives month-end balances from transactions for a transaction account', async () => {
    prismaMock.account.findFirst.mockResolvedValue({
      startingBalance: 1000,
      createdAt: day('2026-09-15'),
      tracksBalance: false,
      transactions: [
        { amount: 200, type: 'INCOME', date: day('2026-10-03') },
        { amount: 50, type: 'EXPENSE', date: day('2026-11-02') },
      ],
      balanceUpdates: [],
    });

    const history = await getAccountHistory('user-1', 'acc-1', 6, NOW);

    expect(history.points.map((p) => p.month)).toEqual([
      202606, 202607, 202608, 202609, 202610, 202611,
    ]);
    expect(history.points.map((p) => p.balance)).toEqual([null, null, null, 1000, 1200, 1150]);
    expect(history.points[5]!.label).toBe('Nov 26');
    expect(history.change).toEqual({ amount: 150, percent: 15 });
    expect(history.updates).toEqual([]);
  });

  it('uses balance updates for a tracked account and returns its log', async () => {
    prismaMock.account.findFirst.mockResolvedValue({
      startingBalance: 0,
      createdAt: day('2026-01-01'),
      tracksBalance: true,
      transactions: [],
      balanceUpdates: [
        { id: 'b2', balance: 5500, date: day('2026-11-01'), note: null, createdAt: NOW },
        { id: 'b1', balance: 5000, date: day('2026-09-30'), note: 'Q3', createdAt: NOW },
      ],
    });

    const history = await getAccountHistory('user-1', 'acc-1', 6, NOW);

    expect(history.points.map((p) => p.balance)).toEqual([null, null, null, 5000, 5000, 5500]);
    expect(history.change).toEqual({ amount: 500, percent: 10 });
    expect(history.updates.map((u) => [u.id, u.change])).toEqual([
      ['b2', '500.00'],
      ['b1', null],
    ]);
  });
});

describe('getNetWorthHistory', () => {
  it('sums every account per month, counting an account with no data yet as 0', async () => {
    prismaMock.account.findMany.mockResolvedValue([
      {
        startingBalance: 1000,
        createdAt: day('2026-10-01'),
        tracksBalance: false,
        transactions: [{ amount: 1500, type: 'EXPENSE', date: day('2026-11-03') }],
        balanceUpdates: [],
      },
      {
        startingBalance: 0,
        createdAt: day('2026-01-01'),
        tracksBalance: true,
        transactions: [],
        balanceUpdates: [{ balance: 8000, date: day('2026-09-15'), createdAt: NOW }],
      },
    ]);

    const history = await getNetWorthHistory('user-1', 6, NOW);

    expect(prismaMock.account.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 'user-1' } }),
    );
    expect(history.points.map((p) => p.balance)).toEqual([null, null, null, 8000, 9000, 7500]);
  });

  it('is empty with no accounts', async () => {
    prismaMock.account.findMany.mockResolvedValue([]);

    const history = await getNetWorthHistory('user-1', 6, NOW);

    expect(history.points.every((p) => p.balance === null)).toBe(true);
    expect(history.change).toBeNull();
  });
});
