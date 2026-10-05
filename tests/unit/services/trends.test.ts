import { beforeEach, describe, expect, it, vi } from 'vitest';

const { prismaMock, spreadFindMany } = vi.hoisted(() => ({
  spreadFindMany: vi.fn(),
  prismaMock: {
    transaction: { findMany: vi.fn() },
    reimbursementLink: { findMany: vi.fn() },
  },
}));

// the manually-completed-reimbursement lookup in listReimbursedAmountsByExpenseDate
// also calls transaction.findMany; route it away so each test's own
// transaction.findMany mocks (and their call order) stay about the ledger rows
vi.mock('@/lib/db/prisma', () => ({
  prisma: {
    ...prismaMock,
    transaction: {
      ...prismaMock.transaction,
      findMany: (args?: {
        where?: { reimbursementCompletedAt?: unknown; spreadEndMonth?: unknown };
      }) =>
        args?.where?.reimbursementCompletedAt
          ? Promise.resolve([])
          : args?.where?.spreadEndMonth
            ? spreadFindMany(args)
            : prismaMock.transaction.findMany(args),
    },
  },
}));

const { getSpendingTrends } = await import('@/lib/services/trends');

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.reimbursementLink.findMany.mockResolvedValue([]);
  spreadFindMany.mockResolvedValue([]);
});

describe('getSpendingTrends', () => {
  it('spreads an expense across the months it covers instead of its payment month', async () => {
    const tax = {
      id: 'tax',
      type: 'EXPENSE',
      amount: 1200,
      date: new Date(Date.UTC(2026, 1, 10)),
      isPayment: false,
      reimbursementIncomeLinks: [],
      isTransfer: false,
      payee: 'City',
      categoryId: null,
      category: null,
      spreadStartMonth: 202511,
      spreadMonths: 4,
    };
    prismaMock.transaction.findMany.mockResolvedValue([tax]);
    spreadFindMany.mockResolvedValue([tax]);

    // range 3 ending Feb 2026: current Dec-Feb, prior Sep-Nov
    const result = await getSpendingTrends('user-1', { month: 202602, range: 3 });

    expect(result.months.map((m) => [m.month, m.expense])).toEqual([
      [202512, 300],
      [202601, 300],
      [202602, 300],
    ]);
    expect(spreadFindMany.mock.calls[0][0].where).toMatchObject({
      spreadStartMonth: { lte: 202602 },
      spreadEndMonth: { gte: 202509 },
    });
    // one uncategorized payment, not one per month it covers
    expect(result.uncategorizedCount).toBe(1);
  });

  it('buckets income/expense per month and computes the headline vs. the prior period', async () => {
    prismaMock.transaction.findMany.mockResolvedValue([
      // prior period (Jan): expense 100
      {
        type: 'EXPENSE',
        amount: 100,
        date: new Date(Date.UTC(2026, 0, 10)),
        isPayment: false,
        reimbursementIncomeLinks: [],
        isTransfer: false,
        category: { id: 'cat-1', name: 'Groceries' },
      },
      // current period (Feb): expense 150, income 500
      {
        type: 'EXPENSE',
        amount: 150,
        date: new Date(Date.UTC(2026, 1, 10)),
        isPayment: false,
        reimbursementIncomeLinks: [],
        isTransfer: false,
        category: { id: 'cat-1', name: 'Groceries' },
      },
      {
        type: 'INCOME',
        amount: 500,
        date: new Date(Date.UTC(2026, 1, 12)),
        isPayment: false,
        reimbursementIncomeLinks: [],
        isTransfer: false,
        category: null,
      },
    ]);

    const result = await getSpendingTrends('user-1', { month: 202602, range: 3 });

    expect(result.months.map((m) => m.month)).toEqual([202512, 202601, 202602]);
    const feb = result.months.find((m) => m.month === 202602)!;
    expect(feb.expense).toBe(150);
    expect(feb.income).toBe(500);

    // range=3 ending Feb -> current period is Dec/Jan/Feb, so Jan's 100
    // and Feb's 150 both land in the current total.
    expect(result.headline.currentTotal).toBe('250.00');
  });

  it('excludes transfers from income, expense, and category totals', async () => {
    prismaMock.transaction.findMany.mockResolvedValue([
      {
        type: 'EXPENSE',
        amount: 60,
        date: new Date(Date.UTC(2026, 1, 5)),
        isPayment: false,
        reimbursementIncomeLinks: [],
        isTransfer: false,
        category: { id: 'cat-1', name: 'Dining' },
      },
      {
        type: 'EXPENSE',
        amount: 400,
        date: new Date(Date.UTC(2026, 1, 5)),
        isPayment: false,
        reimbursementIncomeLinks: [],
        isTransfer: true,
        category: null,
      },
      {
        type: 'INCOME',
        amount: 400,
        date: new Date(Date.UTC(2026, 1, 6)),
        isPayment: false,
        reimbursementIncomeLinks: [],
        isTransfer: true,
        category: null,
      },
    ]);

    const result = await getSpendingTrends('user-1', { month: 202602, range: 3 });

    const feb = result.months.find((m) => m.month === 202602)!;
    expect(feb.expense).toBe(60);
    expect(feb.income).toBe(0);
  });

  it('folds categories past the 6-slot cap into "Other" with a stable color set', async () => {
    const feb = (day: number) => new Date(Date.UTC(2026, 1, day));
    const categories = Array.from({ length: 8 }, (_, i) => ({ id: `cat-${i}`, name: `Cat ${i}` }));
    prismaMock.transaction.findMany.mockResolvedValue(
      categories.map((category, i) => ({
        type: 'EXPENSE',
        // descending amounts so ranking is deterministic
        amount: 100 - i,
        date: feb(1),
        isPayment: false,
        reimbursementIncomeLinks: [],
        isTransfer: false,
        category,
      })),
    );

    const result = await getSpendingTrends('user-1', { month: 202602, range: 3 });

    expect(result.categories).toHaveLength(7);
    expect(result.categories[6].categoryName).toBe('Other');
    expect(result.categories.slice(0, 6).map((c) => c.categoryName)).toEqual([
      'Cat 0',
      'Cat 1',
      'Cat 2',
      'Cat 3',
      'Cat 4',
      'Cat 5',
    ]);
    const febBreakdown = result.categoryBreakdown.find((b) => b.month === 202602)!;
    const otherSegment = febBreakdown.segments.find((s) => s.categoryId === '__other__');
    // Cat 6 (94) + Cat 7 (93)
    expect(otherSegment?.amount).toBe(187);
  });

  it('ranks movers by absolute dollar change between the current and prior period', async () => {
    // range=3 ending Feb -> current = Dec/Jan/Feb, prior = Sep/Oct/Nov 2025.
    prismaMock.transaction.findMany.mockResolvedValue([
      // prior: Dining 50
      {
        type: 'EXPENSE',
        amount: 50,
        date: new Date(Date.UTC(2025, 8, 10)),
        isPayment: false,
        reimbursementIncomeLinks: [],
        isTransfer: false,
        category: { id: 'cat-dining', name: 'Dining' },
      },
      // current (Feb): Dining 170 (+120), Groceries -40 vs its own prior of 40
      {
        type: 'EXPENSE',
        amount: 170,
        date: new Date(Date.UTC(2026, 1, 10)),
        isPayment: false,
        reimbursementIncomeLinks: [],
        isTransfer: false,
        category: { id: 'cat-dining', name: 'Dining' },
      },
      {
        type: 'EXPENSE',
        amount: 40,
        date: new Date(Date.UTC(2025, 8, 15)),
        isPayment: false,
        reimbursementIncomeLinks: [],
        isTransfer: false,
        category: { id: 'cat-groceries', name: 'Groceries' },
      },
    ]);

    const result = await getSpendingTrends('user-1', { month: 202602, range: 3 });

    // categoryId lets the Trends page link each mover to its transactions
    expect(result.movers[0]).toMatchObject({
      categoryId: 'cat-dining',
      categoryName: 'Dining',
      current: 170,
      prior: 50,
      amount: 120,
      tone: 'rose',
    });
    expect(result.movers[1]).toMatchObject({
      categoryId: 'cat-groceries',
      categoryName: 'Groceries',
      current: 0,
      prior: 40,
      amount: -40,
      tone: 'sky',
    });
  });

  it('excludes an income transaction with an active reimbursement link from income totals', async () => {
    prismaMock.transaction.findMany.mockResolvedValue([
      {
        id: 'inc-1',
        type: 'INCOME',
        amount: 500,
        date: new Date(Date.UTC(2026, 1, 10)),
        isPayment: false,
        isTransfer: false,
        reimbursementIncomeLinks: [{ amount: 500 }],
        category: null,
      },
    ]);

    const result = await getSpendingTrends('user-1', { month: 202602, range: 3 });

    const feb = result.months.find((m) => m.month === 202602)!;
    expect(feb.income).toBe(0);
  });

  it('only excludes the linked part of an income used as a reimbursement', async () => {
    prismaMock.transaction.findMany.mockResolvedValue([
      {
        id: 'inc-1',
        type: 'INCOME',
        amount: 500,
        date: new Date(Date.UTC(2026, 1, 10)),
        isPayment: false,
        isTransfer: false,
        reimbursementIncomeLinks: [{ amount: 120 }],
        category: null,
      },
    ]);

    const result = await getSpendingTrends('user-1', { month: 202602, range: 3 });

    const feb = result.months.find((m) => m.month === 202602)!;
    expect(feb.income).toBe(380);
  });

  it('nets a reimbursed expense out of the month total and category breakdown', async () => {
    prismaMock.transaction.findMany.mockResolvedValue([
      {
        id: 'exp-1',
        type: 'EXPENSE',
        amount: 100,
        date: new Date(Date.UTC(2026, 1, 10)),
        isPayment: false,
        isTransfer: false,
        reimbursementIncomeLinks: [],
        category: { id: 'cat-1', name: 'Work' },
      },
    ]);
    prismaMock.reimbursementLink.findMany.mockResolvedValue([
      {
        amount: 30,
        expenseTransactionId: 'exp-1',
        expense: { categoryId: 'cat-1', date: new Date(Date.UTC(2026, 1, 10)) },
      },
    ]);

    const result = await getSpendingTrends('user-1', { month: 202602, range: 3 });

    const feb = result.months.find((m) => m.month === 202602)!;
    expect(feb.expense).toBe(70);
    expect(result.headline.currentTotal).toBe('70.00');
  });

  it('ranks movers using net (post-reimbursement) amounts, not gross', async () => {
    prismaMock.transaction.findMany.mockResolvedValue([
      // prior: Dining 50, no reimbursement
      {
        id: 'exp-prior',
        type: 'EXPENSE',
        amount: 50,
        date: new Date(Date.UTC(2025, 8, 10)),
        isPayment: false,
        isTransfer: false,
        reimbursementIncomeLinks: [],
        category: { id: 'cat-dining', name: 'Dining' },
      },
      // current (Feb): Dining 170 gross, 130 reimbursed -> net 40. Gross vs.
      // prior (50) would read as a +120 rose (spending up) mover; net vs.
      // prior reads as -10, a sky (spending down) mover — the opposite sign.
      {
        id: 'exp-current',
        type: 'EXPENSE',
        amount: 170,
        date: new Date(Date.UTC(2026, 1, 10)),
        isPayment: false,
        isTransfer: false,
        reimbursementIncomeLinks: [],
        category: { id: 'cat-dining', name: 'Dining' },
      },
    ]);
    prismaMock.reimbursementLink.findMany.mockResolvedValue([
      {
        amount: 130,
        expenseTransactionId: 'exp-current',
        expense: { categoryId: 'cat-dining', date: new Date(Date.UTC(2026, 1, 10)) },
      },
    ]);

    const result = await getSpendingTrends('user-1', { month: 202602, range: 3 });

    expect(result.movers[0]).toMatchObject({ categoryName: 'Dining', amount: -10, tone: 'sky' });
  });
});
