import { beforeEach, describe, expect, it, vi } from 'vitest';

const { prismaMock } = vi.hoisted(() => {
  const makeModel = () => ({
    findMany: vi.fn(),
    findUniqueOrThrow: vi.fn(),
    deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    createMany: vi.fn().mockResolvedValue({ count: 0 }),
  });
  const models = {
    user: makeModel(),
    account: makeModel(),
    category: makeModel(),
    importBatch: makeModel(),
    transaction: makeModel(),
    budget: makeModel(),
    categoryRule: makeModel(),
    reimbursementLink: makeModel(),
    categoryAssignment: makeModel(),
    userBudgetSettings: { ...makeModel(), findUnique: vi.fn(), create: vi.fn() },
    // Not part of the 7-model export/import contract. Present only so the two
    // BYOK regression tests below can assert *zero* calls on it.
    userAiSettings: makeModel(),
  };
  return {
    prismaMock: {
      ...models,
      // The service only ever calls `tx.<model>.<method>` inside the
      // callback, so handing back the same mocked models as `tx` is
      // sufficient — no separate transaction-client shape is needed.
      $transaction: vi.fn(async (fn: (tx: typeof models) => Promise<unknown>) => fn(models)),
    },
  };
});

vi.mock('@/lib/db/prisma', () => ({ prisma: prismaMock }));

const { exportUserData, importUserData, wipeUserData } = await import('@/lib/services/userData');
const { USER_DATA_FORMAT_VERSION } = await import('@/lib/validators/user-data');

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.$transaction.mockImplementation(
    async (fn: (tx: typeof prismaMock) => Promise<unknown>) => fn(prismaMock),
  );
});

describe('exportUserData', () => {
  it('omits passwordHash and userId, and serializes decimals/dates', async () => {
    prismaMock.user.findUniqueOrThrow.mockResolvedValue({ email: 'a@example.com', name: 'A' });
    prismaMock.account.findMany.mockResolvedValue([
      {
        id: 'acc1',
        name: 'Checking',
        type: 'CHECKING',
        startingBalance: '100',
        statementDay: null,
        onBudget: true,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      },
    ]);
    prismaMock.categoryAssignment.findMany.mockResolvedValue([]);
    prismaMock.userBudgetSettings.findUnique.mockResolvedValue(null);
    prismaMock.category.findMany.mockResolvedValue([]);
    prismaMock.importBatch.findMany.mockResolvedValue([]);
    prismaMock.transaction.findMany.mockResolvedValue([]);
    prismaMock.budget.findMany.mockResolvedValue([]);
    prismaMock.categoryRule.findMany.mockResolvedValue([]);
    prismaMock.reimbursementLink.findMany.mockResolvedValue([]);

    const file = await exportUserData('user-1');

    expect(file.formatVersion).toBe(USER_DATA_FORMAT_VERSION);
    expect(file.user).toEqual({ email: 'a@example.com', name: 'A' });
    expect(file.data.accounts[0]).toEqual({
      id: 'acc1',
      name: 'Checking',
      type: 'CHECKING',
      startingBalance: '100.00',
      statementDay: null,
      onBudget: true,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    expect(JSON.stringify(file)).not.toContain('passwordHash');
    expect(JSON.stringify(file)).not.toContain('userId');

    // Every findMany call scopes by userId and never selects userId itself.
    for (const model of [
      prismaMock.account,
      prismaMock.category,
      prismaMock.importBatch,
      prismaMock.transaction,
      prismaMock.budget,
      prismaMock.categoryRule,
      prismaMock.reimbursementLink,
    ]) {
      const [args] = model.findMany.mock.calls[0];
      expect(args.where).toEqual({ userId: 'user-1' });
      expect(args.select.userId).toBeUndefined();
    }
  });
});

describe('wipeUserData', () => {
  it('deletes in dependency order: links, budgets/rules, transactions, batches, categories, accounts', async () => {
    const calls: string[] = [];
    for (const [name, model] of [
      ['reimbursementLink', prismaMock.reimbursementLink],
      ['budget', prismaMock.budget],
      ['categoryRule', prismaMock.categoryRule],
      ['transaction', prismaMock.transaction],
      ['importBatch', prismaMock.importBatch],
      ['category', prismaMock.category],
      ['account', prismaMock.account],
    ] as const) {
      model.deleteMany.mockImplementation(async () => {
        calls.push(name);
        return { count: 0 };
      });
    }

    await wipeUserData(prismaMock as never, 'user-1');

    expect(calls.indexOf('reimbursementLink')).toBeLessThan(calls.indexOf('transaction'));
    expect(calls.indexOf('budget')).toBeLessThan(calls.indexOf('category'));
    expect(calls.indexOf('categoryRule')).toBeLessThan(calls.indexOf('category'));
    expect(calls.indexOf('transaction')).toBeLessThan(calls.indexOf('importBatch'));
    expect(calls.indexOf('importBatch')).toBeLessThan(calls.indexOf('category'));
    expect(calls.indexOf('category')).toBeLessThan(calls.indexOf('account'));
    for (const model of [
      prismaMock.reimbursementLink,
      prismaMock.budget,
      prismaMock.categoryRule,
      prismaMock.transaction,
      prismaMock.importBatch,
      prismaMock.category,
      prismaMock.account,
    ]) {
      expect(model.deleteMany).toHaveBeenCalledWith({ where: { userId: 'user-1' } });
    }
  });
});

describe('importUserData', () => {
  const baseFile = {
    formatVersion: USER_DATA_FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    user: { email: 'a@example.com', name: null },
    data: {
      accounts: [
        {
          id: 'old-acc',
          name: 'Checking',
          type: 'CHECKING' as const,
          startingBalance: '0.00',
          statementDay: null,
          createdAt: new Date('2026-01-01'),
        },
      ],
      categories: [
        {
          id: 'old-cat',
          name: 'Groceries',
          isDefault: false,
          createdAt: new Date('2026-01-01'),
        },
      ],
      importBatches: [] as never[],
      transactions: [
        {
          id: 'old-tx-expense',
          accountId: 'old-acc',
          categoryId: 'old-cat',
          amount: '50.00',
          type: 'EXPENSE' as const,
          date: new Date('2026-01-05'),
          payee: 'Store',
          note: null,
          importBatchId: null,
          isPayment: false,
          isTransfer: true,
          transferMatchId: 'old-match',
          isReimbursable: false,
          reimbursementExpectedAmount: null,
          reimbursementCompletedAt: null,
          skippedAt: null,
          createdAt: new Date('2026-01-05'),
        },
        {
          id: 'old-tx-income',
          accountId: 'old-acc',
          categoryId: null,
          amount: '50.00',
          type: 'INCOME' as const,
          date: new Date('2026-01-06'),
          payee: 'Transfer',
          note: null,
          importBatchId: null,
          isPayment: false,
          isTransfer: true,
          transferMatchId: 'old-match',
          isReimbursable: false,
          reimbursementExpectedAmount: null,
          reimbursementCompletedAt: null,
          skippedAt: null,
          createdAt: new Date('2026-01-06'),
        },
      ],
      budgets: [] as never[],
      categoryRules: [] as never[],
      reimbursementLinks: [] as never[],
    },
  };

  it('wipes existing data before writing, and returns per-model counts', async () => {
    const result = await importUserData('user-1', baseFile as never);

    expect(prismaMock.reimbursementLink.deleteMany).toHaveBeenCalled();
    expect(prismaMock.account.createMany).toHaveBeenCalled();
    expect(result.counts).toEqual({
      accounts: 1,
      categories: 1,
      importBatches: 0,
      transactions: 2,
      budgets: 0,
      categoryRules: 0,
      reimbursementLinks: 0,
      categoryAssignments: 0,
    });
  });

  it('restores a spread expense and recomputes its end month rather than trusting the file', async () => {
    const file = structuredClone(baseFile);
    Object.assign(file.data.transactions[0], {
      isTransfer: false,
      transferMatchId: null,
      spreadStartMonth: 202607,
      spreadMonths: 12,
    });

    await importUserData('user-1', file as never);

    const [txArg] = prismaMock.transaction.createMany.mock.calls[0];
    expect(txArg.data[0]).toMatchObject({
      spreadStartMonth: 202607,
      spreadMonths: 12,
      spreadEndMonth: 202706,
    });
  });

  it('imports a pre-spread export (no spread fields) as not spread', async () => {
    await importUserData('user-1', baseFile as never);

    const [txArg] = prismaMock.transaction.createMany.mock.calls[0];
    expect(txArg.data[0]).toMatchObject({
      spreadStartMonth: null,
      spreadMonths: null,
      spreadEndMonth: null,
    });
  });

  it('regenerates every id and rewrites every FK through the same map', async () => {
    await importUserData('user-1', baseFile as never);

    const [accountArg] = prismaMock.account.createMany.mock.calls[0];
    const newAccountId = accountArg.data[0].id;
    expect(newAccountId).not.toBe('old-acc');
    expect(accountArg.data[0].userId).toBe('user-1');

    const [categoryArg] = prismaMock.category.createMany.mock.calls[0];
    const newCategoryId = categoryArg.data[0].id;
    expect(newCategoryId).not.toBe('old-cat');

    const [txArg] = prismaMock.transaction.createMany.mock.calls[0];
    const [expenseRow, incomeRow] = txArg.data;
    expect(expenseRow.id).not.toBe('old-tx-expense');
    expect(incomeRow.id).not.toBe('old-tx-income');
    expect(expenseRow.accountId).toBe(newAccountId);
    expect(incomeRow.accountId).toBe(newAccountId);
    expect(expenseRow.categoryId).toBe(newCategoryId);
    expect(incomeRow.categoryId).toBeNull();

    // Both legs of the transfer pair remap to the *same* new
    // transferMatchId, in its own namespace separate from transaction ids.
    expect(expenseRow.transferMatchId).toBe(incomeRow.transferMatchId);
    expect(expenseRow.transferMatchId).not.toBe('old-match');
    expect(expenseRow.transferMatchId).not.toBe(expenseRow.id);
  });

  it('writes every row scoped to the session userId, never a file-supplied one', async () => {
    await importUserData('some-other-user', baseFile as never);

    const [accountArg] = prismaMock.account.createMany.mock.calls[0];
    const [categoryArg] = prismaMock.category.createMany.mock.calls[0];
    const [txArg] = prismaMock.transaction.createMany.mock.calls[0];
    for (const row of [...accountArg.data, ...categoryArg.data, ...txArg.data]) {
      expect(row.userId).toBe('some-other-user');
    }
  });
});

describe('importUserData zero-based fields', () => {
  const v1File = {
    formatVersion: 1,
    exportedAt: new Date().toISOString(),
    user: { email: 'a@example.com', name: null },
    data: {
      accounts: [
        {
          id: 'old-sav',
          name: 'Savings',
          type: 'SAVINGS' as const,
          startingBalance: '0.00',
          statementDay: null,
          createdAt: new Date('2026-01-01'),
        },
      ],
      categories: [
        { id: 'old-cat', name: 'Groceries', isDefault: false, createdAt: new Date('2026-01-01') },
      ],
      importBatches: [],
      transactions: [],
      budgets: [],
      categoryRules: [],
      reimbursementLinks: [],
    },
  };

  it('derives onBudget from type and leaves the budgeting mode alone for a v1 file', async () => {
    await importUserData('user-1', v1File as never);

    const [accountArg] = prismaMock.account.createMany.mock.calls[0];
    expect(accountArg.data[0].onBudget).toBe(false);
    expect(prismaMock.userBudgetSettings.deleteMany).not.toHaveBeenCalled();
    expect(prismaMock.userBudgetSettings.create).not.toHaveBeenCalled();
  });

  it('restores assignments (remapped) and budget settings from a v2 file', async () => {
    await importUserData('user-1', {
      ...v1File,
      formatVersion: 2,
      data: {
        ...v1File.data,
        categoryAssignments: [{ id: 'a', categoryId: 'old-cat', month: 202601, amount: '-5.00' }],
        budgetSettings: { mode: 'ZERO_BASED', zbbStartMonth: 202601 },
      },
    } as never);

    const [categoryArg] = prismaMock.category.createMany.mock.calls[0];
    const [assignmentArg] = prismaMock.categoryAssignment.createMany.mock.calls[0];
    expect(assignmentArg.data[0]).toEqual(
      expect.objectContaining({
        userId: 'user-1',
        categoryId: categoryArg.data[0].id,
        month: 202601,
        amount: '-5.00',
      }),
    );
    expect(prismaMock.userBudgetSettings.deleteMany).toHaveBeenCalledWith({
      where: { userId: 'user-1' },
    });
    expect(prismaMock.userBudgetSettings.create).toHaveBeenCalledWith({
      data: { userId: 'user-1', mode: 'ZERO_BASED', zbbStartMonth: 202601 },
    });
  });
});

/**
 * BYOK AI settings are excluded from export *by omission* (exportUserData
 * builds an explicit `select` per model and never lists `UserAiSettings`) and
 * preserved across a full-replace restore (`wipeUserData` deliberately does not
 * delete them — the key is not in the export, so wiping it on restore would
 * destroy it irrecoverably). Both properties are invisible in the source; these
 * tests are what make a future accidental addition fail loudly.
 */
describe('BYOK AI settings are excluded from export and survive import', () => {
  it('never reads UserAiSettings, and puts no AI key field in the export payload', async () => {
    prismaMock.user.findUniqueOrThrow.mockResolvedValue({ email: 'a@example.com', name: 'A' });
    for (const model of [
      prismaMock.account,
      prismaMock.category,
      prismaMock.importBatch,
      prismaMock.transaction,
      prismaMock.budget,
      prismaMock.categoryRule,
      prismaMock.reimbursementLink,
    ]) {
      model.findMany.mockResolvedValue([]);
    }
    // A row is available in the mocked layer — the export must still not reach it.
    prismaMock.userAiSettings.findMany.mockResolvedValue([
      {
        provider: 'ANTHROPIC',
        encryptedApiKey: 'v1:iv:tag:ct',
        keyLast4: 'a1b2',
      },
    ]);

    const serialized = JSON.stringify(await exportUserData('user-1'));

    expect(serialized).not.toContain('provider');
    expect(serialized).not.toContain('encryptedApiKey');
    expect(serialized).not.toContain('keyLast4');
    expect(prismaMock.userAiSettings.findMany).not.toHaveBeenCalled();
    expect(prismaMock.userAiSettings.findUniqueOrThrow).not.toHaveBeenCalled();
  });

  it('restore-from-backup preserves AI provider settings', async () => {
    await wipeUserData(prismaMock as never, 'user-1');

    expect(prismaMock.userAiSettings.deleteMany).not.toHaveBeenCalled();
    expect(prismaMock.userAiSettings.createMany).not.toHaveBeenCalled();
    expect(prismaMock.userAiSettings.findMany).not.toHaveBeenCalled();
  });
});
