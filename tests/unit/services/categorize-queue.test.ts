import { beforeEach, describe, expect, it, vi } from 'vitest';

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    categoryRule: { findMany: vi.fn() },
    transaction: { findMany: vi.fn() },
  },
}));

vi.mock('@/lib/db/prisma', () => ({ prisma: prismaMock }));

const { getCategorizeQueue, getCategorizeQueueStats } = await import('@/lib/services/categorize');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getCategorizeQueue', () => {
  it('attaches the lowest-priority matching rule as a suggestion, and leaves unmatched rows without one', async () => {
    prismaMock.categoryRule.findMany.mockResolvedValue([
      {
        categoryId: 'cat-1',
        matchText: 'whole foods',
        priority: 0,
        category: { name: 'Groceries' },
      },
    ]);
    prismaMock.transaction.findMany.mockResolvedValue([
      {
        id: 't1',
        payee: 'Whole Foods #12',
        note: null,
        amount: 42.5,
        type: 'EXPENSE',
        date: new Date('2026-03-05'),
        account: { name: 'Checking' },
      },
      {
        id: 't2',
        payee: 'Mystery Charge',
        note: null,
        amount: 10,
        type: 'INCOME',
        date: new Date('2026-03-06'),
        account: { name: 'Checking' },
      },
    ]);

    const result = await getCategorizeQueue('user-1');

    expect(result).toEqual([
      {
        id: 't1',
        payee: 'Whole Foods #12',
        meta: 'Checking · 2026-03-05',
        amount: '42.50',
        type: 'EXPENSE',
        suggestedCategoryId: 'cat-1',
        suggestedCategoryName: 'Groceries',
        why: 'A rule matches "whole foods" in this transaction.',
      },
      {
        id: 't2',
        payee: 'Mystery Charge',
        meta: 'Checking · 2026-03-06',
        amount: '10.00',
        type: 'INCOME',
        suggestedCategoryId: null,
        suggestedCategoryName: null,
        why: null,
      },
    ]);
    expect(prismaMock.transaction.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          userId: 'user-1',
          categoryId: null,
          skippedAt: null,
          isTransfer: false,
          isPayment: false,
        },
      }),
    );
  });

  it('excludes transactions that have been skipped', async () => {
    prismaMock.categoryRule.findMany.mockResolvedValue([]);
    prismaMock.transaction.findMany.mockResolvedValue([]);

    await getCategorizeQueue('user-1');

    expect(prismaMock.transaction.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ skippedAt: null }),
      }),
    );
  });

  it('narrows to the selected period, with an inclusive end date', async () => {
    prismaMock.categoryRule.findMany.mockResolvedValue([]);
    prismaMock.transaction.findMany.mockResolvedValue([]);

    await getCategorizeQueue('user-1', { from: '2026-09-01', to: '2026-09-30' });

    expect(prismaMock.transaction.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          date: {
            gte: new Date('2026-09-01T00:00:00Z'),
            lt: new Date('2026-10-01T00:00:00Z'),
          },
        }),
      }),
    );
  });

  it('leaves one side open when only one bound is set', async () => {
    prismaMock.categoryRule.findMany.mockResolvedValue([]);
    prismaMock.transaction.findMany.mockResolvedValue([]);

    await getCategorizeQueue('user-1', { from: '2026-09-01', to: null });

    expect(prismaMock.transaction.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ date: { gte: new Date('2026-09-01T00:00:00Z') } }),
      }),
    );
  });

  it('scopes the queue query to the requesting user', async () => {
    prismaMock.categoryRule.findMany.mockResolvedValue([]);
    prismaMock.transaction.findMany.mockResolvedValue([]);

    await getCategorizeQueue('user-2');

    expect(prismaMock.transaction.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ userId: 'user-2' }),
      }),
    );
    expect(prismaMock.categoryRule.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ userId: 'user-2' }),
      }),
    );
  });
});

describe('getCategorizeQueueStats', () => {
  it('excludes transfers and card payments from the counted population', async () => {
    prismaMock.categoryRule.findMany.mockResolvedValue([]);
    prismaMock.transaction.findMany.mockResolvedValue([]);

    await getCategorizeQueueStats('user-1');

    expect(prismaMock.transaction.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          userId: 'user-1',
          categoryId: null,
          skippedAt: null,
          isTransfer: false,
          isPayment: false,
        },
      }),
    );
  });

  it('returns zeroed counts when nothing is waiting in the queue', async () => {
    prismaMock.categoryRule.findMany.mockResolvedValue([]);
    prismaMock.transaction.findMany.mockResolvedValue([]);

    await expect(getCategorizeQueueStats('user-1')).resolves.toEqual({ total: 0, matched: 0 });
  });

  it('counts every queued row in total and only rule-matched rows in matched', async () => {
    prismaMock.categoryRule.findMany.mockResolvedValue([
      { categoryId: 'cat-1', matchText: 'whole foods', priority: 0 },
    ]);
    prismaMock.transaction.findMany.mockResolvedValue([
      { payee: 'Whole Foods #12', note: null },
      { payee: 'Mystery Charge', note: null },
      { payee: 'Another Mystery', note: null },
    ]);

    await expect(getCategorizeQueueStats('user-1')).resolves.toEqual({ total: 3, matched: 1 });
  });

  it('counts a row once even when several rules match it', async () => {
    prismaMock.categoryRule.findMany.mockResolvedValue([
      { categoryId: 'cat-1', matchText: 'whole', priority: 0 },
      { categoryId: 'cat-2', matchText: 'foods', priority: 1 },
    ]);
    prismaMock.transaction.findMany.mockResolvedValue([{ payee: 'Whole Foods #12', note: null }]);

    await expect(getCategorizeQueueStats('user-1')).resolves.toEqual({ total: 1, matched: 1 });
  });

  it('matches against the note when the payee is null', async () => {
    prismaMock.categoryRule.findMany.mockResolvedValue([
      { categoryId: 'cat-1', matchText: 'landlord llc', priority: 0 },
    ]);
    prismaMock.transaction.findMany.mockResolvedValue([
      { payee: null, note: 'LANDLORD LLC rent' },
      { payee: null, note: null },
    ]);

    await expect(getCategorizeQueueStats('user-1')).resolves.toEqual({ total: 2, matched: 1 });
  });

  it('scopes both queries to the requesting user', async () => {
    prismaMock.categoryRule.findMany.mockResolvedValue([]);
    prismaMock.transaction.findMany.mockResolvedValue([]);

    await getCategorizeQueueStats('user-2');

    expect(prismaMock.categoryRule.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ userId: 'user-2' }),
      }),
    );
    expect(prismaMock.transaction.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ userId: 'user-2' }),
      }),
    );
  });
});
