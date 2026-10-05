import { beforeEach, describe, expect, it, vi } from 'vitest';

const { prismaMock, spreadFindMany } = vi.hoisted(() => ({
  spreadFindMany: vi.fn(),
  prismaMock: {
    budget: { findMany: vi.fn() },
    transaction: { groupBy: vi.fn(), findMany: vi.fn() },
    account: { findFirst: vi.fn() },
    categoryRule: { findMany: vi.fn() },
    reimbursementLink: { findMany: vi.fn() },
    // no row = spending-limits mode, which every test here exercises
    userBudgetSettings: { findUnique: vi.fn().mockResolvedValue(null) },
  },
}));

// the manually-completed-reimbursement lookup in listReimbursedAmountsByExpenseDate
// also calls transaction.findMany; route it away so each test's own
// transaction.findMany mocks (and their call order) stay about the ledger rows.
// The spread-window lookup in listSpreadSharesInRange gets its own mock too.
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

const { getOverviewData } = await import('@/lib/services/overview');

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.reimbursementLink.findMany.mockResolvedValue([]);
  spreadFindMany.mockResolvedValue([]);
});

describe('getOverviewData', () => {
  it('computes hero fraction, day bars, and triage stats for a month with no credit card', async () => {
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
      { categoryId: 'cat-1', _sum: { amount: 150 } },
    ]);
    prismaMock.account.findFirst.mockResolvedValue(null);

    const monthTransactions = [
      {
        id: 't1',
        type: 'EXPENSE',
        amount: 150,
        date: new Date(Date.UTC(2026, 2, 5)),
        isPayment: false,
        reimbursementIncomeLinks: [],
        payee: 'Store',
        category: { name: 'Groceries' },
      },
      {
        id: 't2',
        type: 'INCOME',
        amount: 500,
        date: new Date(Date.UTC(2026, 2, 5)),
        isPayment: false,
        reimbursementIncomeLinks: [],
        payee: 'Payroll',
        category: null,
      },
    ];
    prismaMock.transaction.findMany
      .mockResolvedValueOnce(monthTransactions) // month-scoped query
      .mockResolvedValueOnce([{ payee: 'Uncategorized Co', note: null }]); // triage: uncategorized
    prismaMock.categoryRule.findMany.mockResolvedValue([]);

    const result = await getOverviewData('user-1', { month: 202603, day: 5 });

    expect(result.hero.usedFraction).toBeCloseTo(0.75);
    expect(result.hero.hasBudget).toBe(true);
    expect(result.hero.leftLabel).toBe('Left to spend');
    expect(result.hero.leftAmount).toBe('50.00');
    expect(result.hero.income).toBe('500.00');
    expect(result.hero.expense).toBe('150.00');

    const day5 = result.dayBars.find((d) => d.day === 5);
    expect(day5).toEqual({ day: 5, income: 500, expense: 150 });

    expect(result.selectedDay.day).toBe(5);
    expect(result.selectedDay.spent).toBe('150.00');
    expect(result.selectedDay.rows).toHaveLength(2);

    expect(result.triage).toEqual({ total: 1, matched: 0 });
    expect(result.cycleCard).toBeNull();
  });

  it('flags hasBudget false when no budget exists, instead of a misleading $0.00', async () => {
    prismaMock.budget.findMany.mockResolvedValue([]);
    prismaMock.transaction.groupBy.mockResolvedValue([]);
    prismaMock.account.findFirst.mockResolvedValue(null);
    prismaMock.transaction.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    prismaMock.categoryRule.findMany.mockResolvedValue([]);

    const result = await getOverviewData('user-1', { month: 202603 });

    expect(result.hero.hasBudget).toBe(false);
    expect(result.hero.leftAmount).toBe('0.00');
  });

  it('breaks down every expense by category, including unbudgeted, uncategorized, and excluding transfers', async () => {
    prismaMock.budget.findMany.mockResolvedValue([]);
    prismaMock.transaction.groupBy.mockResolvedValue([]);
    prismaMock.account.findFirst.mockResolvedValue(null);
    prismaMock.transaction.findMany
      .mockResolvedValueOnce([
        {
          id: 't1',
          type: 'EXPENSE',
          amount: 100,
          date: new Date(Date.UTC(2026, 2, 5)),
          isPayment: false,
          reimbursementIncomeLinks: [],
          isTransfer: false,
          payee: 'Store',
          categoryId: 'cat-1',
          category: { name: 'Groceries' },
        },
        {
          id: 't2',
          type: 'EXPENSE',
          amount: 40,
          date: new Date(Date.UTC(2026, 2, 6)),
          isPayment: false,
          reimbursementIncomeLinks: [],
          isTransfer: false,
          payee: 'Unknown',
          categoryId: null,
          category: null,
        },
        {
          id: 't3',
          type: 'INCOME',
          amount: 500,
          date: new Date(Date.UTC(2026, 2, 5)),
          isPayment: false,
          reimbursementIncomeLinks: [],
          isTransfer: false,
          payee: 'Payroll',
          categoryId: null,
          category: null,
        },
        {
          // a transfer leg carrying a category shouldn't count as spending in
          // this category, even though it's typed EXPENSE
          id: 't4',
          type: 'EXPENSE',
          amount: 250,
          date: new Date(Date.UTC(2026, 2, 7)),
          isPayment: false,
          reimbursementIncomeLinks: [],
          isTransfer: true,
          payee: 'Payment to Visa',
          categoryId: 'cat-1',
          category: { name: 'Groceries' },
        },
      ])
      .mockResolvedValueOnce([]);
    prismaMock.categoryRule.findMany.mockResolvedValue([]);

    const result = await getOverviewData('user-1', { month: 202603 });

    expect(result.expenseBreakdown).toEqual([
      {
        categoryId: 'cat-1',
        categoryName: 'Groceries',
        categoryIds: ['cat-1'],
        amount: '100.00',
        fraction: 100 / 140,
      },
      {
        categoryId: null,
        categoryName: 'Uncategorized',
        categoryIds: [],
        amount: '40.00',
        fraction: 40 / 140,
      },
    ]);
  });

  it('keeps both legs of a transfer out of income, expense, day bars and day spend', async () => {
    prismaMock.budget.findMany.mockResolvedValue([
      {
        id: 'b1',
        categoryId: 'cat-1',
        month: 202603,
        limitAmount: 300,
        category: { name: 'Groceries' },
      },
    ]);
    prismaMock.transaction.groupBy.mockResolvedValue([
      { categoryId: 'cat-1', _sum: { amount: 60 } },
    ]);
    prismaMock.account.findFirst.mockResolvedValue(null);

    prismaMock.transaction.findMany
      .mockResolvedValueOnce([
        {
          id: 't1',
          type: 'EXPENSE',
          amount: 60,
          date: new Date(Date.UTC(2026, 2, 5)),
          isPayment: false,
          reimbursementIncomeLinks: [],
          isTransfer: false,
          payee: 'Store',
          category: { name: 'Groceries' },
        },
        {
          id: 't2',
          type: 'EXPENSE',
          amount: 400,
          date: new Date(Date.UTC(2026, 2, 5)),
          isPayment: false,
          reimbursementIncomeLinks: [],
          isTransfer: true,
          payee: 'Payment to Visa',
          category: null,
        },
        {
          // isPayment: false on purpose — the income leg of a checking ->
          // savings transfer has no isPayment fallback, so this asserts the
          // isTransfer gate itself
          id: 't3',
          type: 'INCOME',
          amount: 400,
          date: new Date(Date.UTC(2026, 2, 6)),
          isPayment: false,
          reimbursementIncomeLinks: [],
          isTransfer: true,
          payee: 'Transfer in',
          category: null,
        },
      ])
      .mockResolvedValueOnce([]);
    prismaMock.categoryRule.findMany.mockResolvedValue([]);

    const result = await getOverviewData('user-1', { month: 202603, day: 5 });

    expect(result.hero.expense).toBe('60.00');
    expect(result.hero.income).toBe('0.00');
    expect(result.dayBars.find((d) => d.day === 5)).toEqual({ day: 5, income: 0, expense: 60 });
    expect(result.dayBars.find((d) => d.day === 6)).toEqual({ day: 6, income: 0, expense: 0 });
    expect(result.selectedDay.spent).toBe('60.00');
    // transfers stay visible in the ledger — they're real transactions, just
    // not spending
    expect(result.selectedDay.rows.map((r) => r.id)).toEqual(['t1', 't2']);
  });

  it('excludes an income transaction with an active reimbursement link from income totals', async () => {
    prismaMock.budget.findMany.mockResolvedValue([]);
    prismaMock.transaction.groupBy.mockResolvedValue([]);
    prismaMock.account.findFirst.mockResolvedValue(null);
    prismaMock.transaction.findMany
      .mockResolvedValueOnce([
        {
          id: 't1',
          type: 'INCOME',
          amount: 100,
          date: new Date(Date.UTC(2026, 2, 5)),
          isPayment: false,
          isTransfer: false,
          reimbursementIncomeLinks: [{ amount: 100 }],
          payee: 'Reimbursement',
          category: null,
        },
      ])
      .mockResolvedValueOnce([]);
    prismaMock.categoryRule.findMany.mockResolvedValue([]);

    const result = await getOverviewData('user-1', { month: 202603, day: 5 });

    expect(result.hero.income).toBe('0.00');
    expect(result.dayBars.find((d) => d.day === 5)?.income).toBe(0);
  });

  it('only excludes the linked part of an income used as a reimbursement', async () => {
    prismaMock.budget.findMany.mockResolvedValue([]);
    prismaMock.transaction.groupBy.mockResolvedValue([]);
    prismaMock.account.findFirst.mockResolvedValue(null);
    prismaMock.transaction.findMany
      .mockResolvedValueOnce([
        {
          id: 't1',
          type: 'INCOME',
          amount: 100,
          date: new Date(Date.UTC(2026, 2, 5)),
          isPayment: false,
          isTransfer: false,
          reimbursementIncomeLinks: [{ amount: 25 }, { amount: 15 }],
          payee: 'Paycheck',
          category: null,
        },
      ])
      .mockResolvedValueOnce([]);
    prismaMock.categoryRule.findMany.mockResolvedValue([]);

    const result = await getOverviewData('user-1', { month: 202603, day: 5 });

    expect(result.hero.income).toBe('60.00');
    expect(result.dayBars.find((d) => d.day === 5)?.income).toBe(60);
  });

  it('counts an otherwise-identical income row once it has no active links', async () => {
    prismaMock.budget.findMany.mockResolvedValue([]);
    prismaMock.transaction.groupBy.mockResolvedValue([]);
    prismaMock.account.findFirst.mockResolvedValue(null);
    prismaMock.transaction.findMany
      .mockResolvedValueOnce([
        {
          id: 't1',
          type: 'INCOME',
          amount: 100,
          date: new Date(Date.UTC(2026, 2, 5)),
          isPayment: false,
          isTransfer: false,
          reimbursementIncomeLinks: [],
          payee: 'Payroll',
          category: null,
        },
      ])
      .mockResolvedValueOnce([]);
    prismaMock.categoryRule.findMany.mockResolvedValue([]);

    const result = await getOverviewData('user-1', { month: 202603, day: 5 });

    expect(result.hero.income).toBe('100.00');
  });

  it('nets a reimbursed expense out of hero.expense, the pie, day bars, and daySpent', async () => {
    prismaMock.budget.findMany.mockResolvedValue([]);
    prismaMock.transaction.groupBy.mockResolvedValue([]);
    prismaMock.account.findFirst.mockResolvedValue(null);
    prismaMock.transaction.findMany
      .mockResolvedValueOnce([
        {
          id: 'exp-1',
          type: 'EXPENSE',
          amount: 100,
          date: new Date(Date.UTC(2026, 2, 5)),
          isPayment: false,
          isTransfer: false,
          reimbursementIncomeLinks: [],
          payee: 'Office supplies',
          categoryId: 'cat-1',
          category: { name: 'Work' },
        },
      ])
      .mockResolvedValueOnce([]);
    prismaMock.reimbursementLink.findMany.mockResolvedValue([
      {
        amount: 40,
        expenseTransactionId: 'exp-1',
        expense: { categoryId: 'cat-1', date: new Date(Date.UTC(2026, 2, 5)) },
      },
    ]);
    prismaMock.categoryRule.findMany.mockResolvedValue([]);

    const result = await getOverviewData('user-1', { month: 202603, day: 5 });

    expect(result.hero.expense).toBe('60.00');
    expect(result.expenseBreakdown).toEqual([
      {
        categoryId: 'cat-1',
        categoryName: 'Work',
        categoryIds: ['cat-1'],
        amount: '60.00',
        fraction: 1,
      },
    ]);
    expect(result.dayBars.find((d) => d.day === 5)?.expense).toBe(60);
    expect(result.selectedDay.spent).toBe('60.00');
    // the ledger row itself still shows the full, gross amount — it happened,
    // it's just not counted as full out-of-pocket spend anymore
    expect(result.selectedDay.rows[0].amount).toBe('100.00');
  });

  it('does not net reimbursements out of the credit card cycle balance/spend', async () => {
    prismaMock.budget.findMany.mockResolvedValue([]);
    prismaMock.transaction.groupBy.mockResolvedValue([]);
    const statementDay = 1;
    prismaMock.account.findFirst.mockResolvedValue({
      id: 'card-1',
      name: 'Visa',
      statementDay,
      startingBalance: 0,
    });
    prismaMock.transaction.findMany
      .mockResolvedValueOnce([]) // month-scoped query
      .mockResolvedValueOnce([]) // triage
      .mockResolvedValueOnce([
        {
          id: 'exp-1',
          accountId: 'card-1',
          type: 'EXPENSE',
          amount: 100,
          date: new Date(),
          isTransfer: false,
        },
      ]) // cycle-scoped query
      .mockResolvedValueOnce([
        {
          id: 'exp-1',
          accountId: 'card-1',
          type: 'EXPENSE',
          amount: 100,
          date: new Date(),
          isTransfer: false,
        },
      ]); // all-time query for balance
    prismaMock.reimbursementLink.findMany.mockResolvedValue([
      {
        amount: 40,
        expenseTransactionId: 'exp-1',
        expense: { categoryId: null, date: new Date() },
      },
    ]);
    prismaMock.categoryRule.findMany.mockResolvedValue([]);

    const result = await getOverviewData('user-1');

    expect(result.cycleCard?.cycleSpend).toBe('100.00');
    expect(result.cycleCard?.balance).toBe('-100.00');
  });

  it('exposes the category ids behind each budget ring and expense slice for drill-downs', async () => {
    prismaMock.budget.findMany.mockResolvedValue([
      {
        id: 'b1',
        categoryId: 'cat-1',
        month: 202603,
        limitAmount: 500,
        category: { name: 'Cat 1' },
      },
    ]);
    prismaMock.transaction.groupBy.mockResolvedValue([]);
    prismaMock.account.findFirst.mockResolvedValue(null);
    // Eight named categories (80 down to 10) plus a small uncategorized spend:
    // the top six get their own slice, the rest fold into "Other".
    const expenses = Array.from({ length: 8 }, (_, i) => ({
      id: `t${i + 1}`,
      type: 'EXPENSE',
      amount: 80 - i * 10,
      date: new Date(Date.UTC(2026, 2, 5)),
      isPayment: false,
      isTransfer: false,
      reimbursementIncomeLinks: [],
      payee: 'Store',
      categoryId: `cat-${i + 1}`,
      category: { name: `Cat ${i + 1}` },
    }));
    prismaMock.transaction.findMany
      .mockResolvedValueOnce([
        ...expenses,
        {
          id: 't-uncat',
          type: 'EXPENSE',
          amount: 5,
          date: new Date(Date.UTC(2026, 2, 5)),
          isPayment: false,
          isTransfer: false,
          reimbursementIncomeLinks: [],
          payee: 'Unknown',
          categoryId: null,
          category: null,
        },
      ])
      .mockResolvedValueOnce([]);
    prismaMock.categoryRule.findMany.mockResolvedValue([]);

    const result = await getOverviewData('user-1', { month: 202603 });

    expect(result.budgetRings[0].categoryId).toBe('cat-1');
    expect(result.expenseBreakdown.slice(0, 6).map((s) => s.categoryIds)).toEqual([
      ['cat-1'],
      ['cat-2'],
      ['cat-3'],
      ['cat-4'],
      ['cat-5'],
      ['cat-6'],
    ]);
    const other = result.expenseBreakdown[6];
    expect(other.categoryName).toBe('Other');
    expect(other.amount).toBe('35.00');
    // Uncategorized spend folded into Other can't be expressed as an id.
    expect(other.categoryIds).toEqual(['cat-7', 'cat-8']);
  });
  it('counts spread expenses through their monthly shares, never on their own day', async () => {
    prismaMock.budget.findMany.mockResolvedValue([]);
    prismaMock.transaction.groupBy.mockResolvedValue([]);
    prismaMock.account.findFirst.mockResolvedValue(null);
    const marchSpread = {
      id: 'insurance',
      type: 'EXPENSE',
      amount: 1200,
      date: new Date(Date.UTC(2026, 2, 10)),
      isPayment: false,
      isTransfer: false,
      reimbursementIncomeLinks: [],
      payee: 'Insurer',
      categoryId: 'cat-ins',
      category: { name: 'Insurance' },
      spreadStartMonth: 202601,
      spreadMonths: 12,
    };
    prismaMock.transaction.findMany
      .mockResolvedValueOnce([
        {
          id: 'groceries',
          type: 'EXPENSE',
          amount: 100,
          date: new Date(Date.UTC(2026, 2, 5)),
          isPayment: false,
          isTransfer: false,
          reimbursementIncomeLinks: [],
          payee: 'Store',
          categoryId: 'cat-groc',
          category: { name: 'Groceries' },
          spreadStartMonth: null,
          spreadMonths: null,
        },
        marchSpread,
      ])
      .mockResolvedValueOnce([]);
    // the window query: the March-paid spread plus a June-paid one spread
    // backward over Jan-Dec, which the month's date query never sees
    spreadFindMany.mockResolvedValue([
      marchSpread,
      {
        id: 'tax',
        amount: 3600,
        date: new Date(Date.UTC(2026, 5, 15)),
        payee: 'City',
        categoryId: 'cat-tax',
        category: { name: 'Property tax' },
        spreadStartMonth: 202601,
        spreadMonths: 12,
      },
    ]);
    prismaMock.categoryRule.findMany.mockResolvedValue([]);

    const result = await getOverviewData('user-1', { month: 202603, day: 10 });

    expect(result.hero.expense).toBe('500.00');
    expect(result.expenseBreakdown.map((s) => [s.categoryName, s.amount])).toEqual([
      ['Property tax', '300.00'],
      ['Groceries', '100.00'],
      ['Insurance', '100.00'],
    ]);
    expect(result.dayBars.find((d) => d.day === 10)).toEqual({ day: 10, income: 0, expense: 0 });
    expect(result.dayBars.find((d) => d.day === 5)?.expense).toBe(100);
    expect(result.selectedDay.spent).toBe('0.00');
    expect(result.selectedDay.rows).toEqual([
      expect.objectContaining({ id: 'insurance', amount: '1200.00', isSpread: true }),
    ]);
    expect(result.spreadTotal).toBe('400.00');
    expect(result.spreadShares).toEqual([
      {
        transactionId: 'tax',
        payee: 'City',
        categoryName: 'Property tax',
        amount: '300.00',
        sourceMonth: 202606,
        sourceDay: 15,
      },
      {
        transactionId: 'insurance',
        payee: 'Insurer',
        categoryName: 'Insurance',
        amount: '100.00',
        sourceMonth: 202603,
        sourceDay: 10,
      },
    ]);
    expect(spreadFindMany.mock.calls[0][0].where).toMatchObject({
      spreadStartMonth: { lte: 202603 },
      spreadEndMonth: { gte: 202603 },
    });
  });
});
