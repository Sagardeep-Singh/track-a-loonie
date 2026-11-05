import { describe, expect, it } from 'vitest';
import { includeInTotals, summarizeTransactions } from '@/lib/transactions/transaction-summary';

const tx = (
  overrides: Partial<Parameters<typeof summarizeTransactions>[0][number]> = {},
): Parameters<typeof summarizeTransactions>[0][number] => ({
  amount: '10.00',
  type: 'EXPENSE',
  isPayment: false,
  isTransfer: false,
  isReimbursementIncome: false,
  ...overrides,
});

describe('summarizeTransactions', () => {
  it('returns zeros for an empty list', () => {
    expect(summarizeTransactions([])).toEqual({
      count: 0,
      credit: 0,
      debit: 0,
      net: 0,
      payments: 0,
      transfers: 0,
      paymentsIncome: 0,
      transfersIncome: 0,
      reimbursementIncome: 0,
    });
  });

  it('sums credit and debit and derives net', () => {
    const summary = summarizeTransactions([
      tx({ type: 'INCOME', amount: '100.50' }),
      tx({ amount: '40.25' }),
      tx({ amount: '20' }),
    ]);
    expect(summary.credit).toBeCloseTo(100.5);
    expect(summary.debit).toBeCloseTo(60.25);
    expect(summary.net).toBeCloseTo(40.25);
    expect(summary.count).toBe(3);
  });

  it('keeps payments, transfers and reimbursement income out of the totals', () => {
    const summary = summarizeTransactions([
      tx({ amount: '50', isPayment: true, isTransfer: true }),
      tx({ amount: '30', isTransfer: true }),
      tx({ type: 'INCOME', amount: '15', isReimbursementIncome: true }),
      tx({ amount: '5' }),
    ]);
    expect(summary).toMatchObject({
      count: 4,
      credit: 0,
      debit: 5,
      net: -5,
      payments: 50,
      transfers: 30,
      reimbursementIncome: 15,
    });
  });

  it('only moves the linked part of a reimbursement income out of credit', () => {
    const summary = summarizeTransactions([
      tx({
        type: 'INCOME',
        amount: '100',
        isReimbursementIncome: true,
        reimbursementIncomeLinkedTotal: '30.00',
      }),
    ]);
    expect(summary).toMatchObject({ credit: 70, reimbursementIncome: 30, net: 70 });
  });

  it('nets linked reimbursements out of debit, clamped at 0', () => {
    const summary = summarizeTransactions([
      tx({
        amount: '100',
        isReimbursable: true,
        reimbursementExpectedAmount: '100.00',
        reimbursementLinkedTotal: '60.00',
        reimbursementCompletedManually: false,
      }),
      tx({
        amount: '20',
        isReimbursable: true,
        reimbursementExpectedAmount: '20.00',
        reimbursementLinkedTotal: '25.00',
        reimbursementCompletedManually: false,
      }),
    ]);
    expect(summary.debit).toBeCloseTo(40);
    expect(summary.net).toBeCloseTo(-40);
  });

  it('treats a manually completed reimbursement as its full expected amount', () => {
    const summary = summarizeTransactions([
      tx({
        amount: '100',
        isReimbursable: true,
        reimbursementExpectedAmount: '80.00',
        reimbursementLinkedTotal: '10.00',
        reimbursementCompletedManually: true,
      }),
    ]);
    expect(summary.debit).toBeCloseTo(20);
  });

  it('keeps pending reimbursable expenses at their full amount', () => {
    const summary = summarizeTransactions([
      tx({
        amount: '50',
        isReimbursable: true,
        reimbursementExpectedAmount: '50.00',
        reimbursementLinkedTotal: '0.00',
        reimbursementCompletedManually: false,
      }),
    ]);
    expect(summary.debit).toBeCloseTo(50);
  });
});

describe('includeInTotals', () => {
  const summary = summarizeTransactions([
    tx({ type: 'INCOME', amount: '100' }),
    tx({ amount: '40' }),
    tx({ type: 'INCOME', amount: '500', isPayment: true }),
    tx({ amount: '500', isPayment: true }),
    tx({ amount: '200', isTransfer: true }),
    tx({ type: 'INCOME', amount: '150', isTransfer: true }),
  ]);

  it('splits payments and transfers by direction', () => {
    expect(summary).toMatchObject({
      payments: 1000,
      paymentsIncome: 500,
      transfers: 350,
      transfersIncome: 150,
    });
  });

  it('leaves the totals untouched when both are excluded', () => {
    expect(includeInTotals(summary, { payments: false, transfers: false })).toEqual(summary);
  });

  it('adds payments by direction when included', () => {
    expect(includeInTotals(summary, { payments: true, transfers: false })).toMatchObject({
      credit: 600,
      debit: 540,
      net: 60,
    });
  });

  it('adds transfers by direction when included', () => {
    expect(includeInTotals(summary, { payments: false, transfers: true })).toMatchObject({
      credit: 250,
      debit: 240,
      net: 10,
    });
  });

  it('adds both when both are included', () => {
    expect(includeInTotals(summary, { payments: true, transfers: true })).toMatchObject({
      credit: 750,
      debit: 740,
      net: 10,
      count: 6,
    });
  });
});
