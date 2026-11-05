import { beforeEach, describe, expect, it, vi } from 'vitest';

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    transaction: { findFirst: vi.fn(), findMany: vi.fn(), findFirstOrThrow: vi.fn() },
    userBudgetSettings: { findUnique: vi.fn() },
    reimbursementLink: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      groupBy: vi.fn(),
      count: vi.fn(),
      upsert: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    $transaction: vi.fn(),
  },
}));

vi.mock('@/lib/db/prisma', () => ({ prisma: prismaMock }));

const {
  deriveReimbursementStatus,
  toCents,
  getExpenseReimbursement,
  listReimbursedExpenses,
  createReimbursementLink,
  updateReimbursementLink,
  deleteReimbursementLink,
  listReimbursementCandidates,
  getPendingReimbursementSummary,
  listPendingReimbursementExpenseIds,
  assertNoActiveLinks,
  listReimbursedAmounts,
} = await import('@/lib/services/reimbursements');
const { ReimbursementConflictError, ServiceValidationError } =
  await import('@/lib/services/common');

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.$transaction.mockImplementation(
    async (fn: (tx: typeof prismaMock) => Promise<unknown>) => fn(prismaMock),
  );
});

describe('deriveReimbursementStatus', () => {
  it('returns null when not reimbursable, regardless of other values', () => {
    expect(
      deriveReimbursementStatus({
        isReimbursable: false,
        expectedCents: 1000,
        linkedCents: 1000,
        completedAt: new Date(),
      }),
    ).toBeNull();
  });

  it('is COMPLETE when manually completed, even with nothing linked', () => {
    expect(
      deriveReimbursementStatus({
        isReimbursable: true,
        expectedCents: 1000,
        linkedCents: 0,
        completedAt: new Date(),
      }),
    ).toBe('COMPLETE');
  });

  it('is COMPLETE when manually completed despite a shortfall', () => {
    expect(
      deriveReimbursementStatus({
        isReimbursable: true,
        expectedCents: 1000,
        linkedCents: 400,
        completedAt: new Date(),
      }),
    ).toBe('COMPLETE');
  });

  it('is COMPLETE (derived) when linked equals expected', () => {
    expect(
      deriveReimbursementStatus({
        isReimbursable: true,
        expectedCents: 1000,
        linkedCents: 1000,
        completedAt: null,
      }),
    ).toBe('COMPLETE');
  });

  it('is COMPLETE (derived) when linked exceeds expected (overshoot)', () => {
    expect(
      deriveReimbursementStatus({
        isReimbursable: true,
        expectedCents: 1000,
        linkedCents: 1500,
        completedAt: null,
      }),
    ).toBe('COMPLETE');
  });

  it('is PARTIAL when 0 < linked < expected', () => {
    expect(
      deriveReimbursementStatus({
        isReimbursable: true,
        expectedCents: 1000,
        linkedCents: 400,
        completedAt: null,
      }),
    ).toBe('PARTIAL');
  });

  it('is PENDING when nothing is linked', () => {
    expect(
      deriveReimbursementStatus({
        isReimbursable: true,
        expectedCents: 1000,
        linkedCents: 0,
        completedAt: null,
      }),
    ).toBe('PENDING');
  });

  it('is PARTIAL, not COMPLETE, one cent below the expected amount', () => {
    expect(
      deriveReimbursementStatus({
        isReimbursable: true,
        expectedCents: 1000,
        linkedCents: 999,
        completedAt: null,
      }),
    ).toBe('PARTIAL');
  });

  it('reverts a derived COMPLETE to PENDING when links shrink, but a manual COMPLETE stays', () => {
    const derived = deriveReimbursementStatus({
      isReimbursable: true,
      expectedCents: 1000,
      linkedCents: 1000,
      completedAt: null,
    });
    expect(derived).toBe('COMPLETE');

    const derivedAfterRemoval = deriveReimbursementStatus({
      isReimbursable: true,
      expectedCents: 1000,
      linkedCents: 0,
      completedAt: null,
    });
    expect(derivedAfterRemoval).toBe('PENDING');

    const manualAfterRemoval = deriveReimbursementStatus({
      isReimbursable: true,
      expectedCents: 1000,
      linkedCents: 0,
      completedAt: new Date('2026-01-01'),
    });
    expect(manualAfterRemoval).toBe('COMPLETE');
  });
});

describe('toCents', () => {
  it('converts a plain number', () => {
    expect(toCents(10)).toBe(1000);
  });

  it('converts a numeric string, matching how Decimal serializes', () => {
    expect(toCents('12.34')).toBe(1234);
  });

  it('rounds away floating point error instead of truncating', () => {
    expect(toCents(19.99)).toBe(1999);
  });

  it('handles zero', () => {
    expect(toCents(0)).toBe(0);
  });
});

const expenseRow = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'exp-1',
  type: 'EXPENSE',
  amount: 100,
  isReimbursable: true,
  isTransfer: false,
  isPayment: false,
  ...overrides,
});

const incomeRow = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'inc-1',
  type: 'INCOME',
  amount: 100,
  isTransfer: false,
  isPayment: false,
  ...overrides,
});

describe('createReimbursementLink', () => {
  const detailInclude = () => ({
    id: 'exp-1',
    amount: 100,
    isReimbursable: true,
    reimbursementExpectedAmount: 100,
    reimbursementCompletedAt: null,
    reimbursementExpenseLinks: [],
  });

  it('creates a link on the happy path and returns the recomputed summary', async () => {
    prismaMock.transaction.findMany.mockResolvedValue([expenseRow(), incomeRow()]);
    prismaMock.reimbursementLink.findMany.mockResolvedValue([]);
    prismaMock.transaction.findFirstOrThrow.mockResolvedValue({ amount: 100 });
    prismaMock.transaction.findFirst.mockResolvedValue(detailInclude());

    const result = await createReimbursementLink('user-1', {
      expenseTransactionId: 'exp-1',
      incomeTransactionId: 'inc-1',
      amount: 40,
    });

    expect(prismaMock.reimbursementLink.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          expenseTransactionId_incomeTransactionId: {
            expenseTransactionId: 'exp-1',
            incomeTransactionId: 'inc-1',
          },
        },
        create: expect.objectContaining({ userId: 'user-1', amount: 40 }),
        update: { amount: 40 },
      }),
    );
    expect(result.expenseTransactionId).toBe('exp-1');
  });

  it('rejects a transaction linking to itself', async () => {
    await expect(
      createReimbursementLink('user-1', {
        expenseTransactionId: 'tx-1',
        incomeTransactionId: 'tx-1',
        amount: 10,
      }),
    ).rejects.toThrow(ServiceValidationError);
    expect(prismaMock.reimbursementLink.upsert).not.toHaveBeenCalled();
  });

  it('rejects when either transaction is missing or not owned by the user', async () => {
    prismaMock.transaction.findMany.mockResolvedValue([expenseRow()]);

    await expect(
      createReimbursementLink('user-1', {
        expenseTransactionId: 'exp-1',
        incomeTransactionId: 'inc-1',
        amount: 10,
      }),
    ).rejects.toThrow(ServiceValidationError);
  });

  it('rejects when the expense is not flagged reimbursable', async () => {
    prismaMock.transaction.findMany.mockResolvedValue([
      expenseRow({ isReimbursable: false }),
      incomeRow(),
    ]);

    await expect(
      createReimbursementLink('user-1', {
        expenseTransactionId: 'exp-1',
        incomeTransactionId: 'inc-1',
        amount: 10,
      }),
    ).rejects.toThrow(ServiceValidationError);
  });

  it('rejects when the "expense" side is actually an INCOME row', async () => {
    prismaMock.transaction.findMany.mockResolvedValue([
      expenseRow({ type: 'INCOME' }),
      incomeRow(),
    ]);

    await expect(
      createReimbursementLink('user-1', {
        expenseTransactionId: 'exp-1',
        incomeTransactionId: 'inc-1',
        amount: 10,
      }),
    ).rejects.toThrow(ServiceValidationError);
  });

  it('rejects when the "income" side is actually an EXPENSE row', async () => {
    prismaMock.transaction.findMany.mockResolvedValue([
      expenseRow(),
      incomeRow({ type: 'EXPENSE' }),
    ]);

    await expect(
      createReimbursementLink('user-1', {
        expenseTransactionId: 'exp-1',
        incomeTransactionId: 'inc-1',
        amount: 10,
      }),
    ).rejects.toThrow(ServiceValidationError);
  });

  it('rejects an income that is a transfer', async () => {
    prismaMock.transaction.findMany.mockResolvedValue([
      expenseRow(),
      incomeRow({ isTransfer: true }),
    ]);

    await expect(
      createReimbursementLink('user-1', {
        expenseTransactionId: 'exp-1',
        incomeTransactionId: 'inc-1',
        amount: 10,
      }),
    ).rejects.toThrow(ServiceValidationError);
  });

  it('rejects an income that is a card payment', async () => {
    prismaMock.transaction.findMany.mockResolvedValue([
      expenseRow(),
      incomeRow({ isPayment: true }),
    ]);

    await expect(
      createReimbursementLink('user-1', {
        expenseTransactionId: 'exp-1',
        incomeTransactionId: 'inc-1',
        amount: 10,
      }),
    ).rejects.toThrow(ServiceValidationError);
  });

  it('rejects an amount exceeding the income remaining capacity', async () => {
    prismaMock.transaction.findMany.mockResolvedValue([expenseRow(), incomeRow({ amount: 50 })]);
    prismaMock.reimbursementLink.findMany.mockResolvedValue([{ amount: 30 }]);
    prismaMock.transaction.findFirstOrThrow.mockResolvedValue({ amount: 50 });

    await expect(
      createReimbursementLink('user-1', {
        expenseTransactionId: 'exp-1',
        incomeTransactionId: 'inc-1',
        amount: 30,
      }),
    ).rejects.toThrow(ReimbursementConflictError);
    expect(prismaMock.reimbursementLink.upsert).not.toHaveBeenCalled();
  });

  it('allows an amount exactly at the remaining capacity', async () => {
    prismaMock.transaction.findMany.mockResolvedValue([expenseRow(), incomeRow({ amount: 50 })]);
    prismaMock.reimbursementLink.findMany.mockResolvedValue([{ amount: 30 }]);
    prismaMock.transaction.findFirstOrThrow.mockResolvedValue({ amount: 50 });
    prismaMock.transaction.findFirst.mockResolvedValue(detailInclude());

    await createReimbursementLink('user-1', {
      expenseTransactionId: 'exp-1',
      incomeTransactionId: 'inc-1',
      amount: 20,
    });

    expect(prismaMock.reimbursementLink.upsert).toHaveBeenCalled();
  });

  it('recomputes capacity for a repeat link on the same pair, excluding that pair itself', async () => {
    // income fully allocated (50/50) entirely by its link to this same expense;
    // re-submitting the same amount for the same pair must not double-count it
    prismaMock.transaction.findMany.mockResolvedValue([expenseRow(), incomeRow({ amount: 50 })]);
    prismaMock.reimbursementLink.findMany.mockResolvedValue([]); // "other" links excludes this pair
    prismaMock.transaction.findFirstOrThrow.mockResolvedValue({ amount: 50 });
    prismaMock.transaction.findFirst.mockResolvedValue(detailInclude());

    await createReimbursementLink('user-1', {
      expenseTransactionId: 'exp-1',
      incomeTransactionId: 'inc-1',
      amount: 50,
    });

    expect(prismaMock.reimbursementLink.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { incomeTransactionId: 'inc-1', NOT: { expenseTransactionId: 'exp-1' } },
      }),
    );
    expect(prismaMock.reimbursementLink.upsert).toHaveBeenCalled();
  });
});

describe('updateReimbursementLink', () => {
  it('updates the amount within capacity and returns the recomputed summary', async () => {
    prismaMock.reimbursementLink.findFirst.mockResolvedValue({
      expenseTransactionId: 'exp-1',
      incomeTransactionId: 'inc-1',
    });
    prismaMock.reimbursementLink.findMany.mockResolvedValue([]);
    prismaMock.transaction.findFirstOrThrow.mockResolvedValue({ amount: 100 });
    prismaMock.transaction.findFirst.mockResolvedValue({
      id: 'exp-1',
      amount: 100,
      isReimbursable: true,
      reimbursementExpectedAmount: 100,
      reimbursementCompletedAt: null,
      reimbursementExpenseLinks: [],
    });

    await updateReimbursementLink('user-1', 'link-1', { amount: 60 });

    expect(prismaMock.reimbursementLink.update).toHaveBeenCalledWith({
      where: { id: 'link-1' },
      data: { amount: 60 },
    });
  });

  it('throws when the link does not belong to the user', async () => {
    prismaMock.reimbursementLink.findFirst.mockResolvedValue(null);

    await expect(updateReimbursementLink('user-1', 'link-x', { amount: 10 })).rejects.toThrow(
      ServiceValidationError,
    );
    expect(prismaMock.reimbursementLink.update).not.toHaveBeenCalled();
  });

  it('rejects raising the amount past the income remaining capacity, excluding this link', async () => {
    prismaMock.reimbursementLink.findFirst.mockResolvedValue({
      expenseTransactionId: 'exp-1',
      incomeTransactionId: 'inc-1',
    });
    prismaMock.reimbursementLink.findMany.mockResolvedValue([{ amount: 60 }]);
    prismaMock.transaction.findFirstOrThrow.mockResolvedValue({ amount: 100 });

    await expect(updateReimbursementLink('user-1', 'link-1', { amount: 50 })).rejects.toThrow(
      ReimbursementConflictError,
    );
    expect(prismaMock.reimbursementLink.update).not.toHaveBeenCalled();
  });
});

describe('deleteReimbursementLink', () => {
  it('deletes the link and returns the recomputed summary', async () => {
    prismaMock.reimbursementLink.findFirst.mockResolvedValue({ expenseTransactionId: 'exp-1' });
    prismaMock.transaction.findFirst.mockResolvedValue({
      id: 'exp-1',
      amount: 100,
      isReimbursable: true,
      reimbursementExpectedAmount: 100,
      reimbursementCompletedAt: null,
      reimbursementExpenseLinks: [],
    });

    const result = await deleteReimbursementLink('user-1', 'link-1');

    expect(prismaMock.reimbursementLink.delete).toHaveBeenCalledWith({ where: { id: 'link-1' } });
    expect(result.status).toBe('PENDING');
  });

  it('throws when the link does not belong to the user', async () => {
    prismaMock.reimbursementLink.findFirst.mockResolvedValue(null);

    await expect(deleteReimbursementLink('user-1', 'link-x')).rejects.toThrow(
      ServiceValidationError,
    );
    expect(prismaMock.reimbursementLink.delete).not.toHaveBeenCalled();
  });
});

describe('listReimbursedExpenses', () => {
  it('throws for a missing or unowned income', async () => {
    prismaMock.transaction.findFirst.mockResolvedValue(null);

    await expect(listReimbursedExpenses('user-1', 'inc-x')).rejects.toThrow(ServiceValidationError);
    expect(prismaMock.reimbursementLink.findMany).not.toHaveBeenCalled();
  });

  it('scopes links to the user and income, oldest expense first', async () => {
    prismaMock.transaction.findFirst.mockResolvedValue({ id: 'inc-1' });
    prismaMock.reimbursementLink.findMany.mockResolvedValue([]);

    expect(await listReimbursedExpenses('user-1', 'inc-1')).toEqual([]);
    expect(prismaMock.transaction.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'inc-1', userId: 'user-1' } }),
    );
    expect(prismaMock.reimbursementLink.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: 'user-1', incomeTransactionId: 'inc-1' },
        orderBy: [{ expense: { date: 'asc' } }, { createdAt: 'asc' }],
      }),
    );
  });

  it('maps each link to the expense it reimburses, with money as 2dp strings', async () => {
    prismaMock.transaction.findFirst.mockResolvedValue({ id: 'inc-1' });
    prismaMock.reimbursementLink.findMany.mockResolvedValue([
      {
        id: 'link-1',
        expenseTransactionId: 'exp-1',
        incomeTransactionId: 'inc-1',
        amount: 12.5,
        createdAt: new Date('2026-02-01'),
        expense: {
          id: 'exp-1',
          date: new Date('2026-01-15T00:00:00.000Z'),
          amount: 40,
          payee: 'Hotel',
          account: { name: 'Visa' },
        },
      },
    ]);

    expect(await listReimbursedExpenses('user-1', 'inc-1')).toEqual([
      {
        linkId: 'link-1',
        expenseTransactionId: 'exp-1',
        amount: '12.50',
        expenseDate: '2026-01-15T00:00:00.000Z',
        expenseAmount: '40.00',
        expensePayee: 'Hotel',
        expenseAccountName: 'Visa',
      },
    ]);
  });
});

describe('getExpenseReimbursement', () => {
  it('throws for a missing or unowned expense', async () => {
    prismaMock.transaction.findFirst.mockResolvedValue(null);

    await expect(getExpenseReimbursement('user-1', 'exp-x')).rejects.toThrow(
      ServiceValidationError,
    );
  });

  it('sorts links by income date, then createdAt', async () => {
    prismaMock.transaction.findFirst.mockResolvedValue({
      id: 'exp-1',
      amount: 100,
      isReimbursable: true,
      reimbursementExpectedAmount: 100,
      reimbursementCompletedAt: null,
      reimbursementExpenseLinks: [
        {
          id: 'link-b',
          incomeTransactionId: 'inc-b',
          amount: 20,
          createdAt: new Date('2026-01-02'),
          income: {
            id: 'inc-b',
            date: new Date('2026-01-01'),
            amount: 20,
            payee: 'B',
            accountId: 'acc-1',
            account: { name: 'Checking' },
          },
        },
        {
          id: 'link-a',
          incomeTransactionId: 'inc-a',
          amount: 20,
          createdAt: new Date('2026-01-01'),
          income: {
            id: 'inc-a',
            date: new Date('2025-12-31'),
            amount: 20,
            payee: 'A',
            accountId: 'acc-1',
            account: { name: 'Checking' },
          },
        },
      ],
    });

    const result = await getExpenseReimbursement('user-1', 'exp-1');

    expect(result.links.map((l) => l.id)).toEqual(['link-a', 'link-b']);
  });
});

describe('listReimbursementCandidates', () => {
  const expenseDetail = (overrides: Record<string, unknown> = {}) => ({
    id: 'exp-1',
    date: new Date('2026-03-01'),
    payee: 'Office supplies',
    note: null,
    amount: 100,
    isReimbursable: true,
    reimbursementExpectedAmount: 100,
    reimbursementCompletedAt: null,
    reimbursementExpenseLinks: [],
    ...overrides,
  });

  it('throws for a missing or unowned expense', async () => {
    prismaMock.transaction.findFirst.mockResolvedValue(null);

    await expect(listReimbursementCandidates('user-1', 'exp-x')).rejects.toThrow(
      ServiceValidationError,
    );
  });

  it('excludes a fully-allocated income and ranks an exact match highest', async () => {
    prismaMock.transaction.findFirst.mockResolvedValue(expenseDetail());
    prismaMock.transaction.findMany.mockResolvedValue([
      {
        id: 'inc-far',
        date: new Date('2026-04-15'),
        amount: 100,
        payee: 'Refund',
        accountId: 'acc-1',
        account: { name: 'Checking' },
        reimbursementIncomeLinks: [],
      },
      {
        id: 'inc-full',
        date: new Date('2026-03-02'),
        amount: 100,
        payee: 'Fully allocated',
        accountId: 'acc-1',
        account: { name: 'Checking' },
        reimbursementIncomeLinks: [{ amount: 100 }],
      },
      {
        id: 'inc-exact',
        date: new Date('2026-03-02'),
        amount: 100,
        payee: 'Reimbursement',
        accountId: 'acc-1',
        account: { name: 'Checking' },
        reimbursementIncomeLinks: [],
      },
    ]);

    const result = await listReimbursementCandidates('user-1', 'exp-1');

    expect(result.map((c) => c.transactionId)).not.toContain('inc-full');
    expect(result[0].transactionId).toBe('inc-exact');
    expect(result[0].suggestedAmount).toBe('100.00');
  });

  it('only counts an income once it has been reduced by its OTHER links', async () => {
    prismaMock.transaction.findFirst.mockResolvedValue(expenseDetail());
    prismaMock.transaction.findMany.mockResolvedValue([
      {
        id: 'inc-1',
        date: new Date('2026-03-02'),
        amount: 100,
        payee: 'Partially allocated',
        accountId: 'acc-1',
        account: { name: 'Checking' },
        reimbursementIncomeLinks: [{ amount: 60 }],
      },
    ]);

    const result = await listReimbursementCandidates('user-1', 'exp-1');

    expect(result[0].availableAmount).toBe('40.00');
  });

  it('respects a limit option', async () => {
    prismaMock.transaction.findFirst.mockResolvedValue(expenseDetail());
    prismaMock.transaction.findMany.mockResolvedValue(
      Array.from({ length: 5 }, (_, i) => ({
        id: `inc-${i}`,
        date: new Date('2026-03-02'),
        amount: 100,
        payee: `Income ${i}`,
        accountId: 'acc-1',
        account: { name: 'Checking' },
        reimbursementIncomeLinks: [],
      })),
    );

    const result = await listReimbursementCandidates('user-1', 'exp-1', { limit: 2 });

    expect(result).toHaveLength(2);
  });

  it('constrains the default (no-search) pool to income dated on/after the expense', async () => {
    prismaMock.transaction.findFirst.mockResolvedValue(expenseDetail());
    prismaMock.transaction.findMany.mockResolvedValue([]);

    await listReimbursementCandidates('user-1', 'exp-1');

    expect(prismaMock.transaction.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ date: { gte: expenseDetail().date } }),
      }),
    );
  });

  it('drops the date constraint when a search term is supplied', async () => {
    prismaMock.transaction.findFirst.mockResolvedValue(expenseDetail());
    prismaMock.transaction.findMany.mockResolvedValue([]);

    await listReimbursementCandidates('user-1', 'exp-1', { search: 'refund' });

    const where = prismaMock.transaction.findMany.mock.calls[0][0].where;
    expect(where.date).toBeUndefined();
    expect(where.AND).toHaveLength(1);
    expect(prismaMock.transaction.findMany.mock.calls[0][0].orderBy).toEqual({ date: 'desc' });
  });

  it('requires every search word to match payee, note, account or category', async () => {
    prismaMock.transaction.findFirst.mockResolvedValue(expenseDetail());
    prismaMock.transaction.findMany.mockResolvedValue([]);

    await listReimbursementCandidates('user-1', 'exp-1', { search: 'acme 42.50' });

    const and = prismaMock.transaction.findMany.mock.calls[0][0].where.AND;
    expect(and).toHaveLength(2);
    const contains = { contains: 'acme', mode: 'insensitive' };
    expect(and[0].OR).toEqual([
      { payee: contains },
      { note: contains },
      { account: { name: contains } },
      { category: { name: contains } },
    ]);
    expect(and[1].OR).toContainEqual({ amount: 42.5 });
  });

  it('boosts and labels income in the same category as the expense', async () => {
    prismaMock.transaction.findFirst.mockResolvedValue(expenseDetail({ categoryId: 'cat-1' }));
    const income = (id: string, categoryId: string | null) => ({
      id,
      date: new Date('2026-03-20'),
      amount: 80,
      payee: 'Someone',
      accountId: 'acc-1',
      account: { name: 'Checking' },
      categoryId,
      category: categoryId ? { name: categoryId === 'cat-1' ? 'Work' : 'Other' } : null,
      reimbursementIncomeLinks: [],
    });
    prismaMock.transaction.findMany.mockResolvedValue([
      income('inc-other', 'cat-2'),
      income('inc-same', 'cat-1'),
    ]);

    const result = await listReimbursementCandidates('user-1', 'exp-1');

    expect(result[0].transactionId).toBe('inc-same');
    expect(result[0].categoryName).toBe('Work');
    expect(result[0].reasons).toContain('Same category (Work)');
    expect(result[1].reasons).not.toContain('Same category (Other)');
  });

  it('never treats two uncategorized transactions as a category match', async () => {
    prismaMock.transaction.findFirst.mockResolvedValue(expenseDetail({ categoryId: null }));
    prismaMock.transaction.findMany.mockResolvedValue([
      {
        id: 'inc-1',
        date: new Date('2026-03-20'),
        amount: 80,
        payee: 'Someone',
        accountId: 'acc-1',
        account: { name: 'Checking' },
        categoryId: null,
        category: null,
        reimbursementIncomeLinks: [],
      },
    ]);

    const result = await listReimbursementCandidates('user-1', 'exp-1');

    expect(result[0].reasons.some((r) => r.startsWith('Same category'))).toBe(false);
  });
});

describe('listPendingReimbursementExpenseIds', () => {
  it('keeps PENDING and PARTIAL expenses, drops fully linked ones', async () => {
    prismaMock.transaction.findMany.mockResolvedValue([
      { id: 'none-linked', reimbursementExpectedAmount: 100, reimbursementExpenseLinks: [] },
      { id: 'no-expected', reimbursementExpectedAmount: null, reimbursementExpenseLinks: [] },
      {
        id: 'partial',
        reimbursementExpectedAmount: 100,
        reimbursementExpenseLinks: [{ amount: 40 }, { amount: 10 }],
      },
      {
        id: 'complete',
        reimbursementExpectedAmount: 100,
        reimbursementExpenseLinks: [{ amount: 60 }, { amount: 40 }],
      },
    ]);

    const result = await listPendingReimbursementExpenseIds('user-1');

    expect(result).toEqual(['none-linked', 'no-expected', 'partial']);
  });

  it("only reads the user's reimbursable expenses not manually completed", async () => {
    prismaMock.transaction.findMany.mockResolvedValue([]);

    expect(await listPendingReimbursementExpenseIds('user-1')).toEqual([]);
    expect(prismaMock.transaction.findMany.mock.calls[0][0].where).toEqual({
      userId: 'user-1',
      isReimbursable: true,
      reimbursementCompletedAt: null,
    });
  });
});

describe('getPendingReimbursementSummary', () => {
  it('returns a zero summary when nothing is reimbursable', async () => {
    prismaMock.transaction.findMany.mockResolvedValue([]);

    const result = await getPendingReimbursementSummary('user-1');

    expect(result).toEqual({ pendingTotal: '0.00', pendingCount: 0 });
    expect(prismaMock.reimbursementLink.groupBy).not.toHaveBeenCalled();
  });

  it('sums outstanding amounts across multiple pending/partial expenses', async () => {
    prismaMock.transaction.findMany.mockResolvedValue([
      { id: 'exp-1', reimbursementExpectedAmount: 100 },
      { id: 'exp-2', reimbursementExpectedAmount: 50 },
    ]);
    prismaMock.reimbursementLink.groupBy.mockResolvedValue([
      { expenseTransactionId: 'exp-1', _sum: { amount: 40 } },
      { expenseTransactionId: 'exp-2', _sum: { amount: 35 } },
    ]);

    const result = await getPendingReimbursementSummary('user-1');

    expect(result).toEqual({ pendingTotal: '75.00', pendingCount: 2 });
  });

  it('excludes an expense whose outstanding amount has reached zero (overshoot)', async () => {
    prismaMock.transaction.findMany.mockResolvedValue([
      { id: 'exp-1', reimbursementExpectedAmount: 50 },
    ]);
    prismaMock.reimbursementLink.groupBy.mockResolvedValue([
      { expenseTransactionId: 'exp-1', _sum: { amount: 80 } },
    ]);

    const result = await getPendingReimbursementSummary('user-1');

    expect(result).toEqual({ pendingTotal: '0.00', pendingCount: 0 });
  });
});

describe('assertNoActiveLinks', () => {
  it('does nothing for an empty id list, without querying', async () => {
    await assertNoActiveLinks('user-1', [], 'blocked');

    expect(prismaMock.reimbursementLink.count).not.toHaveBeenCalled();
  });

  it('does not throw when none of the ids have an active link', async () => {
    prismaMock.reimbursementLink.count.mockResolvedValue(0);

    await expect(assertNoActiveLinks('user-1', ['tx-1'], 'blocked')).resolves.toBeUndefined();
  });

  it('throws the given message when a transaction has a link as the expense side', async () => {
    prismaMock.reimbursementLink.count.mockResolvedValue(1);

    await expect(assertNoActiveLinks('user-1', ['tx-1'], 'blocked: expense')).rejects.toThrow(
      'blocked: expense',
    );
  });

  it('throws when a transaction has a link as the income side', async () => {
    prismaMock.reimbursementLink.count.mockResolvedValue(1);

    await expect(assertNoActiveLinks('user-1', ['tx-1'], 'blocked: income')).rejects.toThrow(
      ReimbursementConflictError,
    );
  });
});

describe('listReimbursedAmounts (expense-month setting)', () => {
  beforeEach(() => {
    prismaMock.userBudgetSettings.findUnique.mockResolvedValue({
      reimbursementsInExpenseMonth: true,
    });
  });

  it('maps each link to its expense date/category, independent of the link/income date', async () => {
    prismaMock.reimbursementLink.findMany.mockResolvedValue([
      {
        amount: 25,
        expenseTransactionId: 'exp-1',
        expense: { categoryId: 'cat-1', date: new Date('2026-01-15') },
      },
    ]);
    prismaMock.transaction.findMany.mockResolvedValue([]);

    const result = await listReimbursedAmounts(
      'user-1',
      new Date('2026-01-01'),
      new Date('2026-02-01'),
    );

    expect(prismaMock.reimbursementLink.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          expense: expect.objectContaining({
            date: { gte: new Date('2026-01-01'), lt: new Date('2026-02-01') },
          }),
        }),
      }),
    );
    expect(result).toEqual([
      {
        expenseTransactionId: 'exp-1',
        categoryId: 'cat-1',
        expenseDate: new Date('2026-01-15').toISOString(),
        date: new Date('2026-01-15').toISOString(),
        amount: '25.00',
      },
    ]);
  });

  it('adds the unlinked expected amount of a manually completed expense', async () => {
    prismaMock.reimbursementLink.findMany.mockResolvedValue([
      {
        amount: 10,
        expenseTransactionId: 'exp-1',
        expense: { categoryId: 'cat-1', date: new Date('2026-01-15') },
      },
    ]);
    prismaMock.transaction.findMany.mockResolvedValue([
      {
        id: 'exp-1',
        categoryId: 'cat-1',
        date: new Date('2026-01-15'),
        reimbursementExpectedAmount: 80,
        reimbursementExpenseLinks: [{ amount: 10 }],
      },
      {
        id: 'exp-2',
        categoryId: null,
        date: new Date('2026-01-20'),
        reimbursementExpectedAmount: 30,
        reimbursementExpenseLinks: [],
      },
      {
        // already linked in full: no top-up row
        id: 'exp-3',
        categoryId: 'cat-2',
        date: new Date('2026-01-21'),
        reimbursementExpectedAmount: 5,
        reimbursementExpenseLinks: [{ amount: 5 }],
      },
    ]);

    const result = await listReimbursedAmounts(
      'user-1',
      new Date('2026-01-01'),
      new Date('2026-02-01'),
    );

    expect(prismaMock.transaction.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: 'user-1',
          isReimbursable: true,
          reimbursementCompletedAt: { not: null },
        }),
      }),
    );
    const jan15 = new Date('2026-01-15').toISOString();
    const jan20 = new Date('2026-01-20').toISOString();
    expect(result).toEqual([
      {
        expenseTransactionId: 'exp-1',
        categoryId: 'cat-1',
        expenseDate: jan15,
        date: jan15,
        amount: '10.00',
      },
      {
        expenseTransactionId: 'exp-1',
        categoryId: 'cat-1',
        expenseDate: jan15,
        date: jan15,
        amount: '70.00',
      },
      {
        expenseTransactionId: 'exp-2',
        categoryId: null,
        expenseDate: jan20,
        date: jan20,
        amount: '30.00',
      },
    ]);
  });
});

describe('listReimbursedAmounts (default: month the money arrives)', () => {
  beforeEach(() => {
    prismaMock.userBudgetSettings.findUnique.mockResolvedValue(null);
    prismaMock.transaction.findMany.mockResolvedValue([]);
    prismaMock.reimbursementLink.groupBy.mockResolvedValue([]);
  });

  const link = (amount: number, incomeDate: string, createdAt = incomeDate) => ({
    amount,
    expenseTransactionId: 'exp-1',
    createdAt: new Date(createdAt),
    income: { date: new Date(incomeDate) },
    expense: { categoryId: 'cat-1', date: new Date('2026-01-15'), amount: 100 },
  });

  it('scopes links by the income date and dates each row on it', async () => {
    prismaMock.reimbursementLink.findMany.mockResolvedValue([link(25, '2026-03-04')]);

    const result = await listReimbursedAmounts(
      'user-1',
      new Date('2026-03-01'),
      new Date('2026-04-01'),
    );

    expect(prismaMock.reimbursementLink.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          userId: 'user-1',
          expense: { type: 'EXPENSE', isTransfer: false },
          income: { date: { gte: new Date('2026-03-01'), lt: new Date('2026-04-01') } },
        },
      }),
    );
    expect(result).toEqual([
      {
        expenseTransactionId: 'exp-1',
        categoryId: 'cat-1',
        expenseDate: new Date('2026-01-15').toISOString(),
        date: new Date('2026-03-04').toISOString(),
        amount: '25.00',
      },
    ]);
  });

  it('skips the earlier-links lookup when nothing arrived in the window', async () => {
    prismaMock.reimbursementLink.findMany.mockResolvedValue([]);

    const result = await listReimbursedAmounts(
      'user-1',
      new Date('2026-03-01'),
      new Date('2026-04-01'),
    );

    expect(result).toEqual([]);
    expect(prismaMock.reimbursementLink.groupBy).not.toHaveBeenCalled();
  });

  it('caps links oldest first so the total never passes the expense amount', async () => {
    // 30 already came back before March; then 50 and 40 arrive in March
    prismaMock.reimbursementLink.groupBy.mockResolvedValue([
      { expenseTransactionId: 'exp-1', _sum: { amount: 30 } },
    ]);
    prismaMock.reimbursementLink.findMany.mockResolvedValue([
      link(40, '2026-03-20'),
      link(50, '2026-03-04'),
    ]);

    const result = await listReimbursedAmounts(
      'user-1',
      new Date('2026-03-01'),
      new Date('2026-04-01'),
    );

    expect(result.map((r) => [r.date.slice(0, 10), r.amount])).toEqual([
      ['2026-03-04', '50.00'],
      ['2026-03-20', '20.00'],
    ]);
  });

  it('keeps manual top-ups on the expense date', async () => {
    prismaMock.reimbursementLink.findMany.mockResolvedValue([]);
    prismaMock.transaction.findMany.mockResolvedValue([
      {
        id: 'exp-2',
        categoryId: 'cat-1',
        date: new Date('2026-03-10'),
        reimbursementExpectedAmount: 30,
        reimbursementExpenseLinks: [{ amount: 10 }],
      },
    ]);

    const result = await listReimbursedAmounts(
      'user-1',
      new Date('2026-03-01'),
      new Date('2026-04-01'),
    );

    expect(result).toEqual([
      {
        expenseTransactionId: 'exp-2',
        categoryId: 'cat-1',
        expenseDate: new Date('2026-03-10').toISOString(),
        date: new Date('2026-03-10').toISOString(),
        amount: '20.00',
      },
    ]);
  });
});
