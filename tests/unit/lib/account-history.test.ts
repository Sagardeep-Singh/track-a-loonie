import { describe, expect, it } from 'vitest';
import {
  balanceChange,
  historyMonths,
  latestBalanceUpdate,
  parseHistoryRange,
  trackedAccountMonthlyBalances,
  transactionAccountMonthlyBalances,
} from '@/lib/account-history';

const day = (key: string): Date => new Date(`${key}T00:00:00.000Z`);

describe('parseHistoryRange', () => {
  it('accepts the supported ranges and falls back to 12 months', () => {
    expect(parseHistoryRange('6')).toBe(6);
    expect(parseHistoryRange('24')).toBe(24);
    expect(parseHistoryRange('7')).toBe(12);
    expect(parseHistoryRange(undefined)).toBe(12);
    expect(parseHistoryRange('abc')).toBe(12);
  });
});

describe('historyMonths', () => {
  it('returns consecutive months ending at the end month, across a year boundary', () => {
    expect(historyMonths(202602, 4)).toEqual([202511, 202512, 202601, 202602]);
  });
});

describe('transactionAccountMonthlyBalances', () => {
  const account = { startingBalance: '100.00', createdAt: day('2026-02-10') };

  it('adds signed transactions dated before each month end to the starting balance', () => {
    const transactions = [
      { amount: '50.00', type: 'INCOME', date: day('2026-02-15') },
      { amount: '20.10', type: 'EXPENSE', date: day('2026-03-31') },
      { amount: '5.00', type: 'EXPENSE', date: day('2026-04-01') },
    ];

    expect(
      transactionAccountMonthlyBalances(account, transactions, [202602, 202603, 202604]),
    ).toEqual([150, 129.9, 124.9]);
  });

  it('leaves months before the account had any data empty', () => {
    expect(transactionAccountMonthlyBalances(account, [], [202601, 202602])).toEqual([null, 100]);
  });

  it('starts at an imported transaction older than the account itself', () => {
    const transactions = [{ amount: '10.00', type: 'EXPENSE', date: day('2025-12-20') }];

    expect(
      transactionAccountMonthlyBalances(account, transactions, [202511, 202512, 202601]),
    ).toEqual([null, 90, 90]);
  });
});

describe('latestBalanceUpdate', () => {
  it('picks the latest date, and the last logged on a tie', () => {
    const updates = [
      { id: 'a', balance: 1, date: day('2026-03-01'), createdAt: day('2026-03-02') },
      { id: 'b', balance: 2, date: day('2026-03-05'), createdAt: day('2026-03-05') },
      { id: 'c', balance: 3, date: day('2026-03-05'), createdAt: day('2026-03-06') },
      { id: 'd', balance: 4, date: day('2026-02-01'), createdAt: day('2026-03-10') },
    ];

    expect(latestBalanceUpdate(updates)?.id).toBe('c');
    expect(latestBalanceUpdate([])).toBeNull();
  });
});

describe('trackedAccountMonthlyBalances', () => {
  it('uses the latest update on or before each month end, empty before the first', () => {
    const updates = [
      { balance: '5000.00', date: day('2026-02-10'), createdAt: day('2026-02-10') },
      { balance: '5100.00', date: day('2026-02-28'), createdAt: day('2026-03-01') },
      { balance: '5400.25', date: day('2026-04-02'), createdAt: day('2026-04-02') },
    ];

    expect(trackedAccountMonthlyBalances(updates, [202601, 202602, 202603, 202604])).toEqual([
      null,
      5100,
      5100,
      5400.25,
    ]);
  });

  it('is all empty with no updates', () => {
    expect(trackedAccountMonthlyBalances([], [202601, 202602])).toEqual([null, null]);
  });
});

describe('balanceChange', () => {
  it('measures from the first known balance to the last', () => {
    expect(balanceChange([null, 1000, 1100, 1250])).toEqual({ amount: 250, percent: 25 });
  });

  it('measures a drop against the size of a negative start', () => {
    expect(balanceChange([-1000, -500])).toEqual({ amount: 500, percent: 50 });
  });

  it('has no percent when the start is 0, and nothing with no data', () => {
    expect(balanceChange([0, 300])).toEqual({ amount: 300, percent: null });
    expect(balanceChange([null, null])).toBeNull();
    expect(balanceChange([null, 500])).toBeNull();
  });
});
