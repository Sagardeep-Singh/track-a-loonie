import { beforeEach, describe, expect, it, vi } from 'vitest';

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: { transaction: { findMany: vi.fn() } },
}));

vi.mock('@/lib/db/prisma', () => ({ prisma: prismaMock }));

const { listSpreadSharesInRange } = await import('@/lib/services/spreadExpenses');

const row = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'tax',
  amount: 3600,
  categoryId: 'cat-tax',
  category: { name: 'Property tax' },
  payee: 'City',
  date: new Date('2026-06-15T00:00:00.000Z'),
  spreadStartMonth: 202601,
  spreadMonths: 12,
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('listSpreadSharesInRange', () => {
  it('queries by spread window overlap, scoped by user, never by date', async () => {
    prismaMock.transaction.findMany.mockResolvedValue([]);

    await listSpreadSharesInRange('user-1', 202603, 202605);

    const { where } = prismaMock.transaction.findMany.mock.calls[0][0];
    expect(where).toEqual({
      userId: 'user-1',
      type: 'EXPENSE',
      isTransfer: false,
      spreadMonths: { not: null },
      spreadStartMonth: { lte: 202605 },
      spreadEndMonth: { gte: 202603 },
    });
    expect(where.date).toBeUndefined();
  });

  it('returns a June payment spread backward over Jan-Dec as a March share', async () => {
    prismaMock.transaction.findMany.mockResolvedValue([row()]);

    const shares = await listSpreadSharesInRange('user-1', 202603, 202603);

    expect(shares).toEqual([
      {
        transactionId: 'tax',
        categoryId: 'cat-tax',
        categoryName: 'Property tax',
        payee: 'City',
        date: '2026-06-15T00:00:00.000Z',
        month: 202603,
        amount: '300.00',
      },
    ]);
  });

  it('keeps only the shares inside the requested range, across a year boundary', async () => {
    prismaMock.transaction.findMany.mockResolvedValue([
      row({ amount: 1200, spreadStartMonth: 202607, spreadMonths: 12 }),
    ]);

    const shares = await listSpreadSharesInRange('user-1', 202611, 202702);

    expect(shares.map((s) => [s.month, s.amount])).toEqual([
      [202611, '100.00'],
      [202612, '100.00'],
      [202701, '100.00'],
      [202702, '100.00'],
    ]);
  });

  it('carries the rounding remainder on the earliest months', async () => {
    prismaMock.transaction.findMany.mockResolvedValue([
      row({ amount: 100, spreadStartMonth: 202601, spreadMonths: 3 }),
    ]);

    const shares = await listSpreadSharesInRange('user-1', 202601, 202603);

    expect(shares.map((s) => s.amount)).toEqual(['33.34', '33.33', '33.33']);
  });

  it('skips a malformed row with only half of the spread pair', async () => {
    prismaMock.transaction.findMany.mockResolvedValue([row({ spreadMonths: null })]);

    expect(await listSpreadSharesInRange('user-1', 202601, 202612)).toEqual([]);
  });

  it('keeps uncategorized shares with a null category', async () => {
    prismaMock.transaction.findMany.mockResolvedValue([row({ categoryId: null, category: null })]);

    const [share] = await listSpreadSharesInRange('user-1', 202601, 202601);

    expect(share.categoryId).toBeNull();
    expect(share.categoryName).toBeNull();
  });
});
