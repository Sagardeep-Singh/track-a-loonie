import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { prismaMock } = vi.hoisted(() => {
  const models = {
    userBudgetSettings: { findUnique: vi.fn(), upsert: vi.fn() },
    account: { findMany: vi.fn() },
    transaction: { findMany: vi.fn(), groupBy: vi.fn(), aggregate: vi.fn() },
    category: { findMany: vi.fn(), count: vi.fn() },
    categoryAssignment: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      upsert: vi.fn(),
      deleteMany: vi.fn(),
    },
    budget: { findMany: vi.fn() },
    reimbursementLink: { findMany: vi.fn() },
  };
  return {
    prismaMock: {
      ...models,
      $transaction: vi.fn(async (fn: (tx: typeof models) => Promise<unknown>) => fn(models)),
    },
  };
});

vi.mock('@/lib/db/prisma', () => ({ prisma: prismaMock }));

const {
  assignToTargets,
  getZbbMonth,
  listBudgetsForMode,
  moveMoney,
  setAssignment,
  setBudgetMode,
} = await import('@/lib/services/zeroBased');
const { ServiceValidationError } = await import('@/lib/services/common');

type TxRow = {
  id: string;
  categoryId: string | null;
  amount: number;
  date: Date;
  isTransfer: boolean;
  transferMatchId: string | null;
};

/** routes transaction.findMany by query shape: on-budget expenses, transfer
 * counterparts, and the manual-reimbursement lookup */
const mockTransactions = (opts: {
  expenses?: TxRow[];
  counterparts?: { transferMatchId: string }[];
}): void => {
  prismaMock.transaction.findMany.mockImplementation(
    async (args: { where: Record<string, unknown> }) => {
      if (args.where.reimbursementCompletedAt) return [];
      if (args.where.transferMatchId) return opts.counterparts ?? [];
      return opts.expenses ?? [];
    },
  );
};

const zeroBased = (startMonth = 202609): void => {
  prismaMock.userBudgetSettings.findUnique.mockResolvedValue({
    mode: 'ZERO_BASED',
    zbbStartMonth: startMonth,
  });
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-15T12:00:00Z'));
  prismaMock.$transaction.mockImplementation(
    async (fn: (tx: typeof prismaMock) => Promise<unknown>) => fn(prismaMock),
  );
  prismaMock.account.findMany.mockImplementation(async (args: { where: { onBudget?: boolean } }) =>
    args.where.onBudget ? [{ id: 'chq' }, { id: 'visa' }] : [{ startingBalance: 1000 }],
  );
  prismaMock.transaction.groupBy.mockResolvedValue([]);
  prismaMock.transaction.aggregate.mockResolvedValue({
    _count: { _all: 0 },
    _sum: { amount: null },
  });
  prismaMock.category.findMany.mockResolvedValue([
    { id: 'food', name: 'Groceries' },
    { id: 'save', name: 'Savings' },
  ]);
  prismaMock.category.count.mockImplementation(
    async (args: { where: { id: { in: string[] } } }) =>
      args.where.id.in.filter((id) => id === 'food' || id === 'save').length,
  );
  prismaMock.categoryAssignment.findMany.mockResolvedValue([]);
  prismaMock.categoryAssignment.findUnique.mockResolvedValue(null);
  prismaMock.budget.findMany.mockResolvedValue([]);
  prismaMock.reimbursementLink.findMany.mockResolvedValue([]);
  mockTransactions({});
});

afterEach(() => {
  vi.useRealTimers();
});

describe('setBudgetMode', () => {
  it('pins the start month to the current month on first enable', async () => {
    prismaMock.userBudgetSettings.findUnique.mockResolvedValue(null);
    prismaMock.userBudgetSettings.upsert.mockImplementation(
      async (args: { create: unknown }) => args.create,
    );

    const result = await setBudgetMode('user-1', { mode: 'ZERO_BASED' });

    expect(result).toEqual({ mode: 'ZERO_BASED', zbbStartMonth: 202610 });
  });

  it('keeps the original start month when switching back and forth', async () => {
    prismaMock.userBudgetSettings.findUnique.mockResolvedValue({
      mode: 'LIMITS',
      zbbStartMonth: 202601,
    });
    prismaMock.userBudgetSettings.upsert.mockImplementation(
      async (args: { update: unknown }) => args.update,
    );

    const result = await setBudgetMode('user-1', { mode: 'ZERO_BASED' });

    expect(result.zbbStartMonth).toBe(202601);
  });
});

describe('getZbbMonth', () => {
  it('refuses when zero-based mode is off', async () => {
    prismaMock.userBudgetSettings.findUnique.mockResolvedValue(null);
    await expect(getZbbMonth('user-1', 202610)).rejects.toBeInstanceOf(ServiceValidationError);
  });

  it('derives Ready to Assign from on-budget balances minus what is committed', async () => {
    zeroBased();
    // starting 1000 + income 5000 - expenses 300
    prismaMock.transaction.groupBy.mockResolvedValue([
      { type: 'INCOME', _sum: { amount: 5000 } },
      { type: 'EXPENSE', _sum: { amount: 300 } },
    ]);
    prismaMock.categoryAssignment.findMany.mockResolvedValue([
      { categoryId: 'food', month: 202609, amount: 400 },
      { categoryId: 'food', month: 202610, amount: 500 },
    ]);
    mockTransactions({
      expenses: [
        {
          id: 't1',
          categoryId: 'food',
          amount: 300,
          date: new Date('2026-09-10'),
          isTransfer: false,
          transferMatchId: null,
        },
      ],
    });

    const result = await getZbbMonth('user-1', 202610);

    // 5700 balance - (900 assigned - 300 spent)
    expect(result.readyToAssign).toBe('5100.00');
    expect(result.categories.find((c) => c.categoryId === 'food')).toEqual({
      categoryId: 'food',
      categoryName: 'Groceries',
      carriedIn: '100.00',
      assigned: '500.00',
      activity: '0.00',
      available: '600.00',
      target: null,
    });
    // balances only ever read on-budget accounts
    expect(prismaMock.transaction.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ accountId: { in: ['chq', 'visa'] } }),
      }),
    );
  });

  it('counts a transfer leaving the budget, ignores one staying inside it', async () => {
    zeroBased();
    mockTransactions({
      expenses: [
        // chequing -> off-budget savings
        {
          id: 'out',
          categoryId: 'save',
          amount: 800,
          date: new Date('2026-10-02'),
          isTransfer: true,
          transferMatchId: 'm-out',
        },
        // chequing -> visa card payment (both on-budget)
        {
          id: 'pay',
          categoryId: 'food',
          amount: 250,
          date: new Date('2026-10-03'),
          isTransfer: true,
          transferMatchId: 'm-card',
        },
      ],
      counterparts: [{ transferMatchId: 'm-out' }],
    });

    const result = await getZbbMonth('user-1', 202610);

    const byId = Object.fromEntries(result.categories.map((c) => [c.categoryId, c.activity]));
    expect(byId).toEqual({ food: '0.00', save: '800.00' });
    expect(prismaMock.transaction.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          transferMatchId: { in: ['m-out', 'm-card'] },
          accountId: { notIn: ['chq', 'visa'] },
        }),
      }),
    );
  });

  it('returns reimbursed money to the expense category', async () => {
    zeroBased();
    mockTransactions({
      expenses: [
        {
          id: 'lunch',
          categoryId: 'food',
          amount: 60,
          date: new Date('2026-10-04'),
          isTransfer: false,
          transferMatchId: null,
        },
      ],
    });
    prismaMock.reimbursementLink.findMany.mockResolvedValue([
      {
        amount: 20,
        expenseTransactionId: 'lunch',
        expense: { categoryId: 'food', date: new Date('2026-10-04') },
      },
    ]);

    const result = await getZbbMonth('user-1', 202610);

    expect(result.categories.find((c) => c.categoryId === 'food')?.activity).toBe('40.00');
  });

  it('reports uncategorized on-budget spending', async () => {
    zeroBased();
    prismaMock.transaction.aggregate.mockResolvedValue({
      _count: { _all: 2 },
      _sum: { amount: 45.5 },
    });

    const result = await getZbbMonth('user-1', 202610);

    expect(result.uncategorizedOnBudget).toEqual({ count: 2, total: '45.50' });
  });

  it('uses the effective spending limit as each category target', async () => {
    zeroBased();
    prismaMock.budget.findMany.mockResolvedValue([
      { categoryId: 'food', limitAmount: 600 },
      { categoryId: 'food', limitAmount: 400 },
    ]);

    const result = await getZbbMonth('user-1', 202610);

    expect(result.categories.find((c) => c.categoryId === 'food')?.target).toBe('600.00');
    expect(result.categories.find((c) => c.categoryId === 'save')?.target).toBeNull();
  });
});

describe('setAssignment', () => {
  it('upserts the absolute amount for the cell', async () => {
    zeroBased();

    await setAssignment('user-1', { categoryId: 'food', month: 202610, amount: 250.5 });

    expect(prismaMock.categoryAssignment.upsert).toHaveBeenCalledWith({
      where: { userId_categoryId_month: { userId: 'user-1', categoryId: 'food', month: 202610 } },
      create: { userId: 'user-1', categoryId: 'food', month: 202610, amount: '250.50' },
      update: { amount: '250.50' },
    });
  });

  it('deletes the row when set to zero', async () => {
    zeroBased();

    await setAssignment('user-1', { categoryId: 'food', month: 202610, amount: 0 });

    expect(prismaMock.categoryAssignment.deleteMany).toHaveBeenCalledWith({
      where: { userId: 'user-1', categoryId: 'food', month: 202610 },
    });
    expect(prismaMock.categoryAssignment.upsert).not.toHaveBeenCalled();
  });

  it('rejects months before the start or too far ahead', async () => {
    zeroBased(202609);
    await expect(
      setAssignment('user-1', { categoryId: 'food', month: 202608, amount: 1 }),
    ).rejects.toThrow('before zero-based budgeting started');
    await expect(
      setAssignment('user-1', { categoryId: 'food', month: 202711, amount: 1 }),
    ).rejects.toThrow('12 months ahead');
    // exactly 12 months ahead is fine
    await setAssignment('user-1', { categoryId: 'food', month: 202710, amount: 1 });
  });

  it("rejects another user's category", async () => {
    zeroBased();
    await expect(
      setAssignment('user-1', { categoryId: 'theirs', month: 202610, amount: 1 }),
    ).rejects.toThrow('Category not found');
  });

  it('refuses when zero-based mode is off', async () => {
    prismaMock.userBudgetSettings.findUnique.mockResolvedValue({
      mode: 'LIMITS',
      zbbStartMonth: 202601,
    });
    await expect(
      setAssignment('user-1', { categoryId: 'food', month: 202610, amount: 1 }),
    ).rejects.toThrow('not enabled');
  });
});

describe('moveMoney', () => {
  it('moves money between two cells in one transaction', async () => {
    zeroBased();
    prismaMock.categoryAssignment.findUnique.mockImplementation(
      async (args: { where: { userId_categoryId_month: { categoryId: string } } }) =>
        args.where.userId_categoryId_month.categoryId === 'save' ? { amount: 100 } : null,
    );

    await moveMoney('user-1', {
      fromCategoryId: 'save',
      toCategoryId: 'food',
      month: 202610,
      amount: 100,
    });

    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
    // the source cell drops to zero and is removed, the target gets the money
    expect(prismaMock.categoryAssignment.deleteMany).toHaveBeenCalledWith({
      where: { userId: 'user-1', categoryId: 'save', month: 202610 },
    });
    expect(prismaMock.categoryAssignment.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: { amount: '100.00' } }),
    );
  });

  it('lets the source cell go negative (money funded in an earlier month)', async () => {
    zeroBased();

    await moveMoney('user-1', {
      fromCategoryId: 'save',
      toCategoryId: 'food',
      month: 202610,
      amount: 30,
    });

    expect(prismaMock.categoryAssignment.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId_categoryId_month: { userId: 'user-1', categoryId: 'save', month: 202610 } },
        update: { amount: '-30.00' },
      }),
    );
  });
});

describe('assignToTargets', () => {
  beforeEach(() => {
    zeroBased();
    prismaMock.budget.findMany.mockResolvedValue([{ categoryId: 'food', limitAmount: 600 }]);
  });

  it('tops every category up to its target when Ready to Assign covers it', async () => {
    prismaMock.transaction.groupBy.mockResolvedValue([{ type: 'INCOME', _sum: { amount: 0 } }]);

    await assignToTargets('user-1', 202610);

    expect(prismaMock.categoryAssignment.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: { amount: '600.00' } }),
    );
  });

  it('writes nothing and names the shortfall when it cannot', async () => {
    prismaMock.account.findMany.mockImplementation(
      async (args: { where: { onBudget?: boolean } }) =>
        args.where.onBudget ? [{ id: 'chq' }] : [{ startingBalance: 100 }],
    );

    await expect(assignToTargets('user-1', 202610)).rejects.toThrow(
      'needs $600.00 but only $100.00',
    );
    expect(prismaMock.categoryAssignment.upsert).not.toHaveBeenCalled();
  });
});

describe('listBudgetsForMode', () => {
  it('maps funded zero-based categories to limit/spent pairs', async () => {
    zeroBased();
    prismaMock.categoryAssignment.findMany.mockResolvedValue([
      { categoryId: 'food', month: 202610, amount: 500 },
    ]);
    mockTransactions({
      expenses: [
        {
          id: 't',
          categoryId: 'food',
          amount: 120,
          date: new Date('2026-10-05'),
          isTransfer: false,
          transferMatchId: null,
        },
      ],
    });

    const result = await listBudgetsForMode('user-1', 202610);

    expect(result).toEqual([
      {
        id: 'zbb-food-202610',
        categoryId: 'food',
        categoryName: 'Groceries',
        month: 202610,
        limitAmount: '500.00',
        spent: '120.00',
      },
    ]);
  });
});
