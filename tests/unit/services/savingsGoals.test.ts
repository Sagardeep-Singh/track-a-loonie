import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { prismaMock } = vi.hoisted(() => {
  const models = {
    savingsGoal: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      count: vi.fn(),
    },
    userBudgetSettings: { findUnique: vi.fn() },
    transaction: { findMany: vi.fn() },
    categoryAssignment: { findMany: vi.fn() },
    category: { findFirst: vi.fn(), create: vi.fn() },
    budget: { count: vi.fn() },
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
  createSavingsGoal,
  deleteSavingsGoal,
  getGoalEffects,
  getGoalTargets,
  listSavingsGoals,
  setSavingsGoalArchived,
  updateSavingsGoal,
} = await import('@/lib/services/savingsGoals');
const { ServiceValidationError } = await import('@/lib/services/common');

const goalRow = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'g1',
  userId: 'u1',
  categoryId: 'cat-trip',
  targetAmount: 3000,
  targetMonth: 202708,
  startMonth: 202610,
  startingAmount: 0,
  archivedAt: null,
  category: { name: 'Trip to Japan' },
  ...overrides,
});

type Tx = {
  id?: string;
  categoryId: string;
  amount: number;
  date: string;
  type?: 'INCOME' | 'EXPENSE';
};

/** routes transaction.findMany by query shape: goal spending vs transfer contributions */
const mockTransactions = (opts: { spends?: Tx[]; transfers?: Tx[] }): void => {
  prismaMock.transaction.findMany.mockImplementation(
    async (args: { where: Record<string, unknown> }) => {
      const rows = args.where.isTransfer === true ? opts.transfers : opts.spends;
      return (rows ?? []).map((t) => ({ ...t, date: new Date(t.date) }));
    },
  );
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-15T12:00:00Z'));
  prismaMock.userBudgetSettings.findUnique.mockResolvedValue(null);
  prismaMock.categoryAssignment.findMany.mockResolvedValue([]);
  mockTransactions({});
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('listSavingsGoals (limits mode)', () => {
  it('counts transfer legs on spending accounts as contributions, income as withdrawals', async () => {
    prismaMock.savingsGoal.findMany.mockResolvedValue([goalRow()]);
    mockTransactions({
      transfers: [
        { categoryId: 'cat-trip', amount: 272.73, date: '2026-10-05', type: 'EXPENSE' },
        { categoryId: 'cat-trip', amount: 500, date: '2026-12-05', type: 'EXPENSE' },
        { categoryId: 'cat-trip', amount: 100, date: '2026-12-20', type: 'INCOME' },
      ],
    });

    const [goal] = await listSavingsGoals('u1', 202612);

    expect(goal.saved).toBe('672.73');
    expect(goal.contributedThisMonth).toBe('400.00');
    expect(goal.needThisMonth).toBe('303.03');
    expect(goal.status).toBe('BEHIND');
    expect(goal.monthsLeft).toBe(9);
    expect(goal.schedule[0]).toEqual({ month: 202612, amount: '303.03' });

    const transferQuery = prismaMock.transaction.findMany.mock.calls
      .map((c) => c[0])
      .find((args) => args.where.isTransfer === true);
    expect(transferQuery.where).toMatchObject({
      userId: 'u1',
      categoryId: { in: ['cat-trip'] },
      account: { onBudget: true },
    });
  });

  it('reports spending from the goal and the balance it leaves', async () => {
    prismaMock.savingsGoal.findMany.mockResolvedValue([goalRow()]);
    mockTransactions({
      transfers: [{ categoryId: 'cat-trip', amount: 3000, date: '2026-10-05', type: 'EXPENSE' }],
      spends: [
        { id: 't1', categoryId: 'cat-trip', amount: 1400, date: '2027-08-02' },
        { id: 't2', categoryId: 'cat-trip', amount: 1200, date: '2027-08-03' },
      ],
    });

    const [goal] = await listSavingsGoals('u1', 202708);

    expect(goal.status).toBe('FUNDED');
    expect(goal.spent).toBe('2600.00');
    expect(goal.balance).toBe('400.00');
    expect(goal.needThisMonth).toBe('0.00');
  });

  it('only lists archived goals when asked', async () => {
    prismaMock.savingsGoal.findMany.mockResolvedValue([]);
    await listSavingsGoals('u1', 202610);
    expect(prismaMock.savingsGoal.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ where: { userId: 'u1', archivedAt: null } }),
    );
    await listSavingsGoals('u1', 202610, { includeArchived: true });
    expect(prismaMock.savingsGoal.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ where: { userId: 'u1' } }),
    );
  });
});

describe('listSavingsGoals (zero-based)', () => {
  it('uses assignments as contributions and ignores transfers', async () => {
    prismaMock.userBudgetSettings.findUnique.mockResolvedValue({
      mode: 'ZERO_BASED',
      zbbStartMonth: 202609,
    });
    prismaMock.savingsGoal.findMany.mockResolvedValue([goalRow()]);
    prismaMock.categoryAssignment.findMany.mockResolvedValue([
      { categoryId: 'cat-trip', month: 202610, amount: 272.73 },
      { categoryId: 'cat-trip', month: 202611, amount: 272.73 },
      { categoryId: 'cat-trip', month: 202612, amount: 500 },
    ]);
    mockTransactions({
      transfers: [{ categoryId: 'cat-trip', amount: 999, date: '2026-10-05', type: 'EXPENSE' }],
      spends: [{ id: 't1', categoryId: 'cat-trip', amount: 400, date: '2027-01-10' }],
    });

    const [goal] = await listSavingsGoals('u1', 202701);

    // the deposit from the envelope doesn't lower progress or raise the need
    expect(goal.needThisMonth).toBe('244.32');
    expect(goal.status).toBe('ON_TRACK');
    expect(goal.saved).toBe('1045.46');
    expect(goal.balance).toBe('645.46');
    const queries = prismaMock.transaction.findMany.mock.calls.map((c) => c[0]);
    expect(queries.some((args) => args.where.isTransfer === true)).toBe(false);
  });
});

describe('createSavingsGoal', () => {
  const input = { targetAmount: 3000, targetMonth: 202708, startingAmount: 0 };

  beforeEach(() => {
    prismaMock.savingsGoal.count.mockResolvedValue(0);
    prismaMock.budget.count.mockResolvedValue(0);
    prismaMock.savingsGoal.create.mockImplementation(async (args: { data: Record<string, unknown> }) =>
      goalRow(args.data),
    );
  });

  it('creates a goal on an owned category starting this month', async () => {
    prismaMock.category.findFirst.mockResolvedValue({ id: 'cat-trip', name: 'Trip to Japan' });

    const goal = await createSavingsGoal('u1', { ...input, categoryId: 'cat-trip' });

    expect(prismaMock.savingsGoal.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ userId: 'u1', categoryId: 'cat-trip', startMonth: 202610 }),
      }),
    );
    expect(goal.needThisMonth).toBe('272.73');
  });

  it('creates the new category alongside the goal', async () => {
    prismaMock.category.findFirst.mockResolvedValue(null);
    prismaMock.category.create.mockResolvedValue({ id: 'cat-new' });

    await createSavingsGoal('u1', { ...input, newCategoryName: 'Trip to Japan' });

    expect(prismaMock.category.create).toHaveBeenCalledWith({
      data: { userId: 'u1', name: 'Trip to Japan' },
    });
    expect(prismaMock.savingsGoal.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ categoryId: 'cat-new' }) }),
    );
  });

  it('rejects a new category name that already exists', async () => {
    prismaMock.category.findFirst.mockResolvedValue({ id: 'cat-trip' });
    await expect(
      createSavingsGoal('u1', { ...input, newCategoryName: 'Trip to Japan' }),
    ).rejects.toThrow('A category with this name already exists');
  });

  it("rejects someone else's category", async () => {
    prismaMock.category.findFirst.mockResolvedValue(null);
    await expect(createSavingsGoal('u1', { ...input, categoryId: 'other' })).rejects.toThrow(
      'Category not found',
    );
    expect(prismaMock.category.findFirst).toHaveBeenCalledWith({
      where: { id: 'other', userId: 'u1' },
    });
  });

  it('rejects a category that already has a goal or a spending limit', async () => {
    prismaMock.category.findFirst.mockResolvedValue({ id: 'cat-trip' });
    prismaMock.savingsGoal.count.mockResolvedValue(1);
    await expect(createSavingsGoal('u1', { ...input, categoryId: 'cat-trip' })).rejects.toThrow(
      'already has a savings goal',
    );

    prismaMock.savingsGoal.count.mockResolvedValue(0);
    prismaMock.budget.count.mockResolvedValue(1);
    await expect(createSavingsGoal('u1', { ...input, categoryId: 'cat-trip' })).rejects.toThrow(
      'Remove the limit',
    );
    expect(prismaMock.savingsGoal.create).not.toHaveBeenCalled();
  });

  it('rejects a target month in the past or too far out', async () => {
    await expect(
      createSavingsGoal('u1', { ...input, categoryId: 'cat-trip', targetMonth: 202609 }),
    ).rejects.toThrow(ServiceValidationError);
    await expect(
      createSavingsGoal('u1', { ...input, categoryId: 'cat-trip', targetMonth: 203611 }),
    ).rejects.toThrow('at most 10 years');
  });
});

describe('updating, archiving and deleting', () => {
  it('updates amounts on an owned goal', async () => {
    prismaMock.savingsGoal.findFirst.mockResolvedValue(goalRow());
    await updateSavingsGoal('u1', 'g1', {
      targetAmount: 3500,
      targetMonth: 202709,
      startingAmount: 100,
    });
    expect(prismaMock.savingsGoal.update).toHaveBeenCalledWith({
      where: { id: 'g1' },
      data: { targetAmount: 3500, targetMonth: 202709, startingAmount: 100 },
    });
  });

  it('rejects a target month before the goal started', async () => {
    prismaMock.savingsGoal.findFirst.mockResolvedValue(goalRow());
    await expect(
      updateSavingsGoal('u1', 'g1', { targetAmount: 3000, targetMonth: 202609, startingAmount: 0 }),
    ).rejects.toThrow(ServiceValidationError);
  });

  it('throws for a goal that is not the user’s', async () => {
    prismaMock.savingsGoal.findFirst.mockResolvedValue(null);
    await expect(setSavingsGoalArchived('u1', 'g1', true)).rejects.toThrow(
      'Savings goal not found',
    );
    await expect(deleteSavingsGoal('u1', 'g1')).rejects.toThrow('Savings goal not found');
    expect(prismaMock.savingsGoal.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'g1', userId: 'u1' } }),
    );
  });

  it('archives and unarchives', async () => {
    prismaMock.savingsGoal.findFirst.mockResolvedValue(goalRow());
    await setSavingsGoalArchived('u1', 'g1', true);
    expect(prismaMock.savingsGoal.update.mock.calls[0][0].data.archivedAt).toBeInstanceOf(Date);
    await setSavingsGoalArchived('u1', 'g1', false);
    expect(prismaMock.savingsGoal.update.mock.calls[1][0].data).toEqual({ archivedAt: null });
  });

  it('deletes the goal only', async () => {
    prismaMock.savingsGoal.findFirst.mockResolvedValue(goalRow());
    await deleteSavingsGoal('u1', 'g1');
    expect(prismaMock.savingsGoal.delete).toHaveBeenCalledWith({ where: { id: 'g1' } });
  });
});

describe('getGoalEffects', () => {
  it('returns nothing without goals and skips the activity queries', async () => {
    prismaMock.savingsGoal.findMany.mockResolvedValue([]);
    const effects = await getGoalEffects('u1', 202610);
    expect(effects.goalCategoryIds.size).toBe(0);
    expect(prismaMock.transaction.findMany).not.toHaveBeenCalled();
  });

  it('reports saved per month and covered spending, archived goals included', async () => {
    prismaMock.savingsGoal.findMany.mockResolvedValue([
      goalRow({ archivedAt: new Date('2027-09-01') }),
    ]);
    mockTransactions({
      transfers: [
        { categoryId: 'cat-trip', amount: 2000, date: '2026-10-05', type: 'EXPENSE' },
        { categoryId: 'cat-trip', amount: 1000, date: '2026-11-05', type: 'EXPENSE' },
      ],
      spends: [
        { id: 'flights', categoryId: 'cat-trip', amount: 2000, date: '2027-08-02' },
        { id: 'hotel', categoryId: 'cat-trip', amount: 1300, date: '2027-08-03' },
      ],
    });

    const effects = await getGoalEffects('u1', 202708);

    expect(prismaMock.savingsGoal.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 'u1' } }),
    );
    expect(effects.goalCategoryIds).toEqual(new Set(['cat-trip']));
    expect(effects.savedByMonth).toEqual(
      new Map([
        [202610, 200000],
        [202611, 100000],
      ]),
    );
    expect(effects.coveredByTransaction).toEqual(
      new Map([
        ['flights', 200000],
        ['hotel', 100000],
      ]),
    );
    expect(effects.uncoveredByMonth).toEqual(new Map([[202708, 30000]]));
  });
});

describe('getGoalTargets', () => {
  it("returns this month's need per active goal category", async () => {
    prismaMock.savingsGoal.findMany.mockResolvedValue([goalRow()]);
    const targets = await getGoalTargets('u1', 202610);
    expect(targets.get('cat-trip')).toEqual({
      goalId: 'g1',
      needCents: 27273,
      targetAmount: '3000.00',
      targetMonth: 202708,
    });
    expect(prismaMock.savingsGoal.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 'u1', archivedAt: null } }),
    );
  });
});
