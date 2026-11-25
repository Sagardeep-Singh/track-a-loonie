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
    userBudgetSettings: {
      findUnique: vi.fn(),
    },
    savingsGoal: {
      count: vi.fn(),
    },
  },
}));

vi.mock('@/lib/db/prisma', () => ({ prisma: prismaMock }));

const { listBudgets, createBudget } = await import('@/lib/services/budgets');
const { ServiceValidationError } = await import('@/lib/services/common');

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.reimbursementLink.findMany.mockResolvedValue([]);
  prismaMock.userBudgetSettings.findUnique.mockResolvedValue(null);
  prismaMock.transaction.findMany.mockResolvedValue([]);
  prismaMock.savingsGoal.count.mockResolvedValue(0);
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

  it('reads the newest row per category at or before the month, with no lower bound', async () => {
    prismaMock.budget.findMany.mockResolvedValue([]);
    prismaMock.transaction.groupBy.mockResolvedValue([]);

    await listBudgets('user-1', 202603);

    expect(prismaMock.budget.findMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.budget.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: 'user-1', month: { lte: 202603 } },
        orderBy: [{ categoryId: 'asc' }, { month: 'desc' }],
        distinct: ['categoryId'],
      }),
    );
  });

  // Regression: a 12-month window used to fall back to the full history only
  // when it came back empty, so one recent budget hid every older one.
  it('keeps a budget set over a year ago next to a recently changed one', async () => {
    prismaMock.budget.findMany.mockResolvedValue([
      {
        id: 'b-rent',
        categoryId: 'cat-rent',
        month: 202401,
        limitAmount: 1800,
        category: { name: 'Rent' },
      },
      {
        id: 'b-food',
        categoryId: 'cat-food',
        month: 202602,
        limitAmount: 400,
        category: { name: 'Groceries' },
      },
    ]);
    prismaMock.transaction.groupBy.mockResolvedValue([]);

    const result = await listBudgets('user-1', 202603);

    expect(result.map((b) => [b.categoryName, b.month, b.limitAmount])).toEqual([
      ['Groceries', 202602, '400.00'],
      ['Rent', 202401, '1800.00'],
    ]);
  });
});

describe('listBudgets reimbursement net-out (expense-month setting)', () => {
  beforeEach(() => {
    prismaMock.userBudgetSettings.findUnique.mockResolvedValue({
      reimbursementsInExpenseMonth: true,
    });
  });

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
    // listReimbursedAmounts is itself scoped by [start, end) on the expense's
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

  it('rejects a limit on a category that has a savings goal', async () => {
    prismaMock.category.findFirst.mockResolvedValue({ id: 'cat-1', name: 'Trip to Japan' });
    prismaMock.savingsGoal.count.mockResolvedValue(1);

    await expect(
      createBudget('user-1', { categoryId: 'cat-1', month: 202603, limitAmount: 100 }),
    ).rejects.toThrow('This category has a savings goal');
    expect(prismaMock.savingsGoal.count).toHaveBeenCalledWith({
      where: { userId: 'user-1', categoryId: 'cat-1' },
    });
    expect(prismaMock.budget.create).not.toHaveBeenCalled();
  });
});

describe('listBudgets reimbursement net-out (default)', () => {
  it('keeps spend in full: reimbursements are income, not negative spend', async () => {
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
      { categoryId: 'cat-1', _sum: { amount: 90 } },
    ]);

    const result = await listBudgets('user-1', 202603);

    expect(result[0].spent).toBe('90.00');
    expect(prismaMock.reimbursementLink.findMany).not.toHaveBeenCalled();
  });
});
