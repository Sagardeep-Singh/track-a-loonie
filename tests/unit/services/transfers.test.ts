import { beforeEach, describe, expect, it, vi } from 'vitest';

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    transaction: { findMany: vi.fn(), update: vi.fn() },
    $transaction: vi.fn(),
  },
}));

vi.mock('@/lib/db/prisma', () => ({ prisma: prismaMock }));

const { matchTransfers } = await import('@/lib/services/transfers');

const day = (d: number): Date => new Date(Date.UTC(2026, 2, d));

type Row = {
  id: string;
  accountId: string;
  amount: number;
  type: 'INCOME' | 'EXPENSE';
  date: Date;
};

const row = (
  id: string,
  accountId: string,
  amount: number,
  type: Row['type'],
  dayOfMonth: number,
): Row => ({ id, accountId, amount, type, date: day(dayOfMonth) });

/** ids passed to `transaction.update`, in call order */
const updatedIds = (): string[] =>
  prismaMock.transaction.update.mock.calls.map((call) => call[0].where.id);

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.transaction.update.mockImplementation((args: { where: { id: string } }) => args);
  prismaMock.$transaction.mockImplementation(async (ops: unknown[]) => ops);
});

describe('matchTransfers', () => {
  it('pairs an equal-amount expense and income on different accounts inside the window', async () => {
    prismaMock.transaction.findMany.mockResolvedValue([
      row('exp-1', 'checking', 250, 'EXPENSE', 10),
      row('inc-1', 'visa', 250, 'INCOME', 12),
    ]);

    const result = await matchTransfers('user-1');

    expect(result).toEqual({ matched: 1 });
    expect(prismaMock.transaction.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          userId: 'user-1',
          isTransfer: false,
          isReimbursable: false,
          spreadMonths: null,
          reimbursementExpenseLinks: { none: {} },
          reimbursementIncomeLinks: { none: {} },
        },
      }),
    );
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
    expect(updatedIds()).toEqual(['exp-1', 'inc-1']);

    const [expenseUpdate, incomeUpdate] = prismaMock.transaction.update.mock.calls;
    expect(expenseUpdate[0].data.isTransfer).toBe(true);
    expect(incomeUpdate[0].data.isTransfer).toBe(true);
    expect(expenseUpdate[0].data.transferMatchId).toEqual(incomeUpdate[0].data.transferMatchId);
    expect(expenseUpdate[0].data.transferMatchId).toEqual(expect.any(String));
  });

  it('does not match two legs on the same account', async () => {
    prismaMock.transaction.findMany.mockResolvedValue([
      row('exp-1', 'checking', 250, 'EXPENSE', 10),
      row('inc-1', 'checking', 250, 'INCOME', 11),
    ]);

    expect(await matchTransfers('user-1')).toEqual({ matched: 0 });
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  it('does not match legs dated further apart than the 5-day window', async () => {
    prismaMock.transaction.findMany.mockResolvedValue([
      row('exp-1', 'checking', 250, 'EXPENSE', 10),
      row('inc-1', 'visa', 250, 'INCOME', 16),
    ]);

    expect(await matchTransfers('user-1')).toEqual({ matched: 0 });
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  it('matches legs exactly 5 days apart (window boundary is inclusive)', async () => {
    prismaMock.transaction.findMany.mockResolvedValue([
      row('exp-1', 'checking', 250, 'EXPENSE', 10),
      row('inc-1', 'visa', 250, 'INCOME', 15),
    ]);

    expect(await matchTransfers('user-1')).toEqual({ matched: 1 });
  });

  it('does not match different amounts', async () => {
    prismaMock.transaction.findMany.mockResolvedValue([
      row('exp-1', 'checking', 250, 'EXPENSE', 10),
      row('inc-1', 'visa', 250.01, 'INCOME', 11),
    ]);

    expect(await matchTransfers('user-1')).toEqual({ matched: 0 });
  });

  it('consumes each candidate once, so two expenses cannot share one income', async () => {
    prismaMock.transaction.findMany.mockResolvedValue([
      row('exp-1', 'checking', 100, 'EXPENSE', 10),
      row('exp-2', 'checking', 100, 'EXPENSE', 11),
      row('inc-1', 'visa', 100, 'INCOME', 10),
    ]);

    const result = await matchTransfers('user-1');

    expect(result).toEqual({ matched: 1 });
    expect(updatedIds()).toEqual(['exp-1', 'inc-1']);
  });

  it('picks the nearest-dated income candidate', async () => {
    prismaMock.transaction.findMany.mockResolvedValue([
      row('inc-far', 'visa', 100, 'INCOME', 8),
      row('exp-1', 'checking', 100, 'EXPENSE', 10),
      row('inc-near', 'visa', 100, 'INCOME', 11),
    ]);

    await matchTransfers('user-1');

    expect(updatedIds()).toEqual(['exp-1', 'inc-near']);
  });

  it('never reconsiders rows already flagged as transfers', async () => {
    prismaMock.transaction.findMany.mockResolvedValue([]);

    expect(await matchTransfers('user-1')).toEqual({ matched: 0 });
    expect(prismaMock.transaction.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          userId: 'user-1',
          isTransfer: false,
          isReimbursable: false,
          spreadMonths: null,
          reimbursementExpenseLinks: { none: {} },
          reimbursementIncomeLinks: { none: {} },
        },
      }),
    );
  });

  it('scans the full history when no date range is given (manual match button)', async () => {
    prismaMock.transaction.findMany.mockResolvedValue([]);

    await matchTransfers('user-1');

    const where = prismaMock.transaction.findMany.mock.calls[0][0].where;
    expect(where.date).toBeUndefined();
  });

  it('bounds the scan to the given date range padded by the match window', async () => {
    prismaMock.transaction.findMany.mockResolvedValue([]);

    await matchTransfers('user-1', { from: day(10), to: day(20) });

    const where = prismaMock.transaction.findMany.mock.calls[0][0].where;
    expect(where.date).toEqual({
      gte: new Date(day(10).getTime() - 5 * 86_400_000),
      lte: new Date(day(20).getTime() + 5 * 86_400_000),
    });
  });

  it('batches every matched pair into a single $transaction call', async () => {
    prismaMock.transaction.findMany.mockResolvedValue([
      row('exp-1', 'checking', 100, 'EXPENSE', 10),
      row('inc-1', 'visa', 100, 'INCOME', 10),
      row('exp-2', 'checking', 200, 'EXPENSE', 12),
      row('inc-2', 'savings', 200, 'INCOME', 12),
    ]);

    const result = await matchTransfers('user-1');

    expect(result).toEqual({ matched: 2 });
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
    expect(prismaMock.$transaction.mock.calls[0][0]).toHaveLength(4);
  });

  it('gives each matched pair its own transferMatchId', async () => {
    prismaMock.transaction.findMany.mockResolvedValue([
      row('exp-1', 'checking', 100, 'EXPENSE', 10),
      row('inc-1', 'visa', 100, 'INCOME', 10),
      row('exp-2', 'checking', 200, 'EXPENSE', 12),
      row('inc-2', 'savings', 200, 'INCOME', 12),
    ]);

    const result = await matchTransfers('user-1');

    expect(result).toEqual({ matched: 2 });
    const ids = prismaMock.transaction.update.mock.calls.map(
      (call) => call[0].data.transferMatchId,
    );
    expect(ids[0]).toBe(ids[1]);
    expect(ids[2]).toBe(ids[3]);
    expect(ids[0]).not.toBe(ids[2]);
  });
});
