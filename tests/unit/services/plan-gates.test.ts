import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Each gated service refuses a Free user with a PlanRestrictionError before it
 * writes anything. Billing is switched on and there's no subscription, so the
 * real entitlements service resolves every user to Free.
 */

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    subscription: { findFirst: vi.fn() },
    account: { count: vi.fn(), create: vi.fn(), findFirst: vi.fn(), update: vi.fn() },
    category: { findFirst: vi.fn() },
    transaction: { create: vi.fn(), findFirst: vi.fn(), update: vi.fn(), findMany: vi.fn() },
    reimbursementLink: { upsert: vi.fn(), findFirst: vi.fn() },
    notificationPreference: { findUnique: vi.fn(), upsert: vi.fn() },
    pushSubscription: { upsert: vi.fn() },
    $transaction: vi.fn(),
  },
}));

vi.mock('@/lib/db/prisma', () => ({ prisma: prismaMock }));

const { createAccount, updateAccount } = await import('@/lib/services/accounts');
const { createTransaction, updateTransaction } = await import('@/lib/services/transactions');
const { createReimbursementLink, listReimbursementCandidates } =
  await import('@/lib/services/reimbursements');
const { getSpendingTrends } = await import('@/lib/services/trends');
const { updateReminderPreference } = await import('@/lib/services/reminders');
const { savePushSubscription } = await import('@/lib/services/pushSubscriptions');
const { importUserData } = await import('@/lib/services/userData');
const { PlanRestrictionError } = await import('@/lib/services/common');
const { USER_DATA_FORMAT_VERSION } = await import('@/lib/validators/user-data');

const restriction = (key: string) => expect.objectContaining({ key, name: 'PlanRestrictionError' });

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_123');
  prismaMock.subscription.findFirst.mockResolvedValue(null);
  prismaMock.account.findFirst.mockResolvedValue({
    id: 'acc-1',
    userId: 'user-1',
    type: 'CREDIT_CARD',
    statementDay: 15,
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('accounts', () => {
  it('refuses a third account', async () => {
    prismaMock.account.count.mockResolvedValue(2);
    await expect(
      createAccount('user-1', { name: 'Visa', type: 'CHECKING', startingBalance: 0 }),
    ).rejects.toEqual(restriction('accounts'));
    expect(prismaMock.account.create).not.toHaveBeenCalled();
  });

  it('refuses setting a statement day on a new card', async () => {
    prismaMock.account.count.mockResolvedValue(0);
    await expect(
      createAccount('user-1', {
        name: 'Visa',
        type: 'CREDIT_CARD',
        startingBalance: 0,
        statementDay: 10,
      }),
    ).rejects.toEqual(restriction('statementCycles'));
  });

  it('refuses changing a stored statement day but allows keeping or clearing it', async () => {
    await expect(updateAccount('user-1', 'acc-1', { statementDay: 20 })).rejects.toEqual(
      restriction('statementCycles'),
    );

    prismaMock.account.update.mockResolvedValue({
      id: 'acc-1',
      name: 'Visa',
      type: 'CREDIT_CARD',
      startingBalance: 0,
      createdAt: new Date(),
      statementDay: null,
      onBudget: true,
      transactions: [],
      importBatches: [],
    });
    await expect(updateAccount('user-1', 'acc-1', { statementDay: null })).resolves.toBeDefined();
    await expect(updateAccount('user-1', 'acc-1', { statementDay: 15 })).resolves.toBeDefined();
  });
});

describe('reimbursements', () => {
  it('refuses marking a new expense reimbursable', async () => {
    await expect(
      createTransaction('user-1', {
        accountId: 'acc-1',
        amount: 20,
        type: 'EXPENSE',
        date: new Date('2026-11-01'),
        isPayment: false,
        isTransfer: false,
        isReimbursable: true,
        reimbursementExpectedAmount: 20,
      } as never),
    ).rejects.toEqual(restriction('reimbursements'));
    expect(prismaMock.transaction.create).not.toHaveBeenCalled();
  });

  it('refuses flipping an existing expense to reimbursable', async () => {
    prismaMock.transaction.findFirst.mockResolvedValue({
      id: 'tx-1',
      accountId: 'acc-1',
      type: 'EXPENSE',
      amount: 20,
      isTransfer: false,
      isPayment: false,
      isReimbursable: false,
      reimbursementExpectedAmount: null,
      reimbursementExpenseLinks: [],
      reimbursementIncomeLinks: [],
    });
    await expect(
      updateTransaction('user-1', 'tx-1', { isReimbursable: true } as never),
    ).rejects.toEqual(restriction('reimbursements'));
  });

  it('refuses linking and searching for repayments', async () => {
    await expect(
      createReimbursementLink('user-1', {
        expenseTransactionId: 'tx-1',
        incomeTransactionId: 'tx-2',
        amount: 10,
      } as never),
    ).rejects.toBeInstanceOf(PlanRestrictionError);
    await expect(listReimbursementCandidates('user-1', 'tx-1')).rejects.toBeInstanceOf(
      PlanRestrictionError,
    );
    expect(prismaMock.reimbursementLink.upsert).not.toHaveBeenCalled();
  });
});

describe('trends', () => {
  it('refuses on Free', async () => {
    await expect(getSpendingTrends('user-1')).rejects.toEqual(restriction('trends'));
    expect(prismaMock.transaction.findMany).not.toHaveBeenCalled();
  });
});

describe('push reminders', () => {
  it('refuses turning reminders on or adding a device', async () => {
    await expect(
      updateReminderPreference('user-1', { enabled: true, cadence: 'DAILY' }),
    ).rejects.toEqual(restriction('pushReminders'));
    await expect(
      savePushSubscription(
        'user-1',
        { endpoint: 'https://push.example/1', keys: { p256dh: 'p', auth: 'a' } },
        null,
      ),
    ).rejects.toEqual(restriction('pushReminders'));
    expect(prismaMock.pushSubscription.upsert).not.toHaveBeenCalled();
  });

  it('still lets a downgraded user turn them off', async () => {
    prismaMock.notificationPreference.findUnique.mockResolvedValue(null);
    prismaMock.notificationPreference.upsert.mockResolvedValue({
      enabled: false,
      cadence: 'DAILY',
      lastSentAt: null,
    });
    await expect(
      updateReminderPreference('user-1', { enabled: false, cadence: 'DAILY' }),
    ).resolves.toMatchObject({ enabled: false });
  });
});

describe('data restore', () => {
  const account = (id: string) => ({
    id,
    name: id,
    type: 'CHECKING',
    startingBalance: '0',
    statementDay: null,
    onBudget: true,
    createdAt: '2026-01-01T00:00:00.000Z',
  });

  it('refuses a backup with more accounts than the plan allows, before wiping anything', async () => {
    const file = {
      formatVersion: USER_DATA_FORMAT_VERSION,
      exportedAt: '2026-11-01T00:00:00.000Z',
      data: {
        accounts: [account('a'), account('b'), account('c')],
        categories: [],
        importBatches: [],
        transactions: [],
        budgets: [],
        categoryRules: [],
        reimbursementLinks: [],
      },
    };
    await expect(importUserData('user-1', file as never)).rejects.toEqual(restriction('accounts'));
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });
});
