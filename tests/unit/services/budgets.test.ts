import { beforeEach, describe, expect, it, vi } from 'vitest';

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    budget: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
    },
    transaction: {
      groupBy: vi.fn(),
      findMany: vi.fn(),
    },
    category: {
      findFirst: vi.fn(),
    },
    reimbursementLink: {
      findMany: vi.fn(),
    },
  },
}));

vi.mock('@/lib/db/prisma', () => ({ prisma: prismaMock }));

const { listBudgets, createBudget } = await import('@/lib/services/budgets');
const { ServiceValidationError } = await import('@/lib/services/common');

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.reimbursementLink.findMany.mockResolvedValue([]);
  prismaMock.transaction.findMany.mockResolvedValue([]);
});

describe('listBudgets', () => {
  it('counts spread expenses by monthly share and keeps them out of the date-based sum', async () => {
    prismaMock.budget.findMany.mockResolvedValue([
      {
        id: 'b1',
        categoryId: 'cat-tax',
        month: 202603,
        limitAmount: 400,
        category: { name: 'Property tax' },
      },
    ]);
    // the date-based groupBy (spread rows excluded) has nothing for March
    prismaMock.transaction.groupBy.mockResolvedValue([]);
    prismaMock.transaction.findMany.mockImplementation(
      async (args: { where?: { spreadEndMonth?: unknown } }) =>
        args?.where?.spreadEndMonth
          ? [
              {
                id: 'tax',
                amount: 3600,
                date: new Date('2026-06-15'),
                payee: 'City',
                categoryId: 'cat-tax',
                category: { name: 'Property tax' },
                spreadStartMonth: 202601,
                spreadMonths: 12,
              },
            ]
          : [],
    );

    const [budget] = await listBudgets('user-1', 202603);

    expect(budget.spent).toBe('300.00');
    expect(prismaMock.transaction.groupBy.mock.calls[0][0].where).toMatchObject({
      spreadMonths: null,
    });
  });

  it('pairs each budget with expense spend for that category and month', async () => {
    prismaMock.budget.findMany.mockResolvedValue([
      {
        id: 'b1',
        categoryId: 'cat-1',
        month: 202603,
        limitAmount: 200,
        category: { name: 'Groceries' },
      },
    ]);
    prismaMock.transaction.groupBy.mockResolvedValue([
      { categoryId: 'cat-1', _sum: { amount: 75.5 } },
    ]);

    const result = await listBudgets('user-1', 202603);

    expect(result).toEqual([
      {
        id: 'b1',
        categoryId: 'cat-1',
        categoryName: 'Groceries',
        month: 202603,
        limitAmount: '200.00',
        spent: '75.50',
      },
    ]);
    // a transfer leg isn't spending, even when it carries a category
    expect(prismaMock.transaction.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ isTransfer: false }),
      }),
    );
  });

  it('carries a budget forward into later months until a newer one overrides it', async () => {
    prismaMock.budget.findMany.mockResolvedValue([
      {
        id: 'b-newer',
        categoryId: 'cat-1',
        month: 202602,
        limitAmount: 250,
        category: { name: 'Groceries' },
      },
      {
        id: 'b-older',
        categoryId: 'cat-1',
        month: 202601,
        limitAmount: 200,
        category: { name: 'Groceries' },
      },
    ]);
    prismaMock.transaction.groupBy.mockResolvedValue([]);

    const result = await listBudgets('user-1', 202604);

    expect(result).toEqual([
      {
        id: 'b-newer',
        categoryId: 'cat-1',
        categoryName: 'Groceries',
        month: 202602,
        limitAmount: '250.00',
        spent: '0.00',
      },
    ]);
  });

  // The carry-forward lookback is bounded so the query can't scan a user's
  // entire budget history. `month - 100` is the same month a year earlier on a
  // YYYYMM int; a category whose newest budget predates that window is
  // knowingly not carried forward.
  it('bounds the carry-forward lookback to 12 months back', async () => {
    prismaMock.budget.findMany.mockResolvedValue([]);
    prismaMock.transaction.groupBy.mockResolvedValue([]);

    await listBudgets('user-1', 202603);

    expect(prismaMock.budget.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: 'user-1', month: { gte: 202503, lte: 202603 } },
      }),
    );
  });

  it('keeps the lookback inside the same year when crossing January', async () => {
    prismaMock.budget.findMany.mockResolvedValue([]);
    prismaMock.transaction.groupBy.mockResolvedValue([]);

    await listBudgets('user-1', 202601);

    expect(prismaMock.budget.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: 'user-1', month: { gte: 202501, lte: 202601 } },
      }),
    );
  });

  it('falls back to an unbounded lookback when a budget predates the 12-month window', async () => {
    const staleBudget = {
      id: 'b-stale',
      categoryId: 'cat-1',
      month: 202401,
      limitAmount: 150,
      category: { name: 'Groceries' },
    };
    prismaMock.budget.findMany
      .mockResolvedValueOnce([]) // bounded query: nothing in the last 12 months
      .mockResolvedValueOnce([staleBudget]); // unbounded fallback finds the stale row
    prismaMock.transaction.groupBy.mockResolvedValue([]);

    const result = await listBudgets('user-1', 202603);

    expect(result).toEqual([
      {
        id: 'b-stale',
        categoryId: 'cat-1',
        categoryName: 'Groceries',
        month: 202401,
        limitAmount: '150.00',
        spent: '0.00',
      },
    ]);
    expect(prismaMock.budget.findMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ where: { userId: 'user-1', month: { gte: 202503, lte: 202603 } } }),
    );
    expect(prismaMock.budget.findMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ where: { userId: 'user-1', month: { lte: 202603 } } }),
    );
  });
});

describe('listBudgets reimbursement net-out', () => {
  it('subtracts the reimbursed amount from spend for that category', async () => {
    prismaMock.budget.findMany.mockResolvedValue([
      {
        id: 'b1',
        categoryId: 'cat-1',
        month: 202603,
        limitAmount: 200,
        category: { name: 'Groceries' },
      },
    ]);
    prismaMock.transaction.groupBy.mockResolvedValue([
      { categoryId: 'cat-1', _sum: { amount: 100 } },
    ]);
    prismaMock.reimbursementLink.findMany.mockResolvedValue([
      {
        amount: 40,
        expenseTransactionId: 'tx-1',
        expense: { categoryId: 'cat-1', date: new Date('2026-03-05') },
      },
    ]);

    const result = await listBudgets('user-1', 202603);

    expect(result[0].spent).toBe('60.00');
  });

  it('clamps spend at 0 when reimbursements exceed the gross spend', async () => {
    prismaMock.budget.findMany.mockResolvedValue([
      {
        id: 'b1',
        categoryId: 'cat-1',
        month: 202603,
        limitAmount: 200,
        category: { name: 'Groceries' },
      },
    ]);
    prismaMock.transaction.groupBy.mockResolvedValue([
      { categoryId: 'cat-1', _sum: { amount: 30 } },
    ]);
    prismaMock.reimbursementLink.findMany.mockResolvedValue([
      {
        amount: 50,
        expenseTransactionId: 'tx-1',
        expense: { categoryId: 'cat-1', date: new Date('2026-03-05') },
      },
    ]);

    const result = await listBudgets('user-1', 202603);

    expect(result[0].spent).toBe('0.00');
  });

  it('nets out by the expense date, independent of when the reimbursement was recorded', async () => {
    // listReimbursedAmountsByExpenseDate is itself scoped by [start, end) on the expense's
    // date — this mock only proves listBudgets applies whatever it returns, keyed by
    // categoryId, without re-deriving month scoping of its own.
    prismaMock.budget.findMany.mockResolvedValue([
      {
        id: 'b1',
        categoryId: 'cat-1',
        month: 202601,
        limitAmount: 200,
        category: { name: 'Groceries' },
      },
    ]);
    prismaMock.transaction.groupBy.mockResolvedValue([
      { categoryId: 'cat-1', _sum: { amount: 100 } },
    ]);
    prismaMock.reimbursementLink.findMany.mockResolvedValue([
      {
        amount: 20,
        expenseTransactionId: 'tx-1',
        expense: { categoryId: 'cat-1', date: new Date('2026-01-10') },
      },
    ]);

    const result = await listBudgets('user-1', 202601);

    expect(result[0].spent).toBe('80.00');
  });

  it('leaves spend unchanged for a category with no reimbursed amount', async () => {
    prismaMock.budget.findMany.mockResolvedValue([
      {
        id: 'b1',
        categoryId: 'cat-1',
        month: 202603,
        limitAmount: 200,
        category: { name: 'Groceries' },
      },
    ]);
    prismaMock.transaction.groupBy.mockResolvedValue([
      { categoryId: 'cat-1', _sum: { amount: 75.5 } },
    ]);

    const result = await listBudgets('user-1', 202603);

    expect(result[0].spent).toBe('75.50');
  });
});

describe('createBudget', () => {
  it('rejects a duplicate budget for the same category and month', async () => {
    prismaMock.category.findFirst.mockResolvedValue({ id: 'cat-1', name: 'Groceries' });
    prismaMock.budget.findFirst.mockResolvedValue({ id: 'existing' });

    await expect(
      createBudget('user-1', { categoryId: 'cat-1', month: 202603, limitAmount: 100 }),
    ).rejects.toThrow(ServiceValidationError);
    expect(prismaMock.budget.create).not.toHaveBeenCalled();
  });
});
