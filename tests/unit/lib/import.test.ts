import { describe, expect, it } from 'vitest';
import {
  guessSplitColumns,
  parseCsvAmount,
  resolveImportedTransactionType,
  resolveSplitColumnAmount,
} from '@/lib/import';

describe('resolveImportedTransactionType', () => {
  it('treats a negative amount as an expense for a checking/savings/cash account', () => {
    expect(resolveImportedTransactionType(-42.5, 'CHECKING')).toBe('EXPENSE');
    expect(resolveImportedTransactionType(-42.5, 'SAVINGS')).toBe('EXPENSE');
    expect(resolveImportedTransactionType(-42.5, 'CASH')).toBe('EXPENSE');
  });

  it('treats a positive amount as income for a checking/savings/cash account', () => {
    expect(resolveImportedTransactionType(42.5, 'CHECKING')).toBe('INCOME');
  });

  it('treats a positive amount as an expense for a credit card account (a charge)', () => {
    expect(resolveImportedTransactionType(42.5, 'CREDIT_CARD')).toBe('EXPENSE');
  });

  it('treats a negative amount as income for a credit card account (a payment or refund)', () => {
    expect(resolveImportedTransactionType(-42.5, 'CREDIT_CARD')).toBe('INCOME');
  });

  it('uses the credit card convention for a line of credit', () => {
    expect(resolveImportedTransactionType(42.5, 'LINE_OF_CREDIT')).toBe('EXPENSE');
    expect(resolveImportedTransactionType(-42.5, 'LINE_OF_CREDIT')).toBe('INCOME');
  });

  it('uses the debit convention for registered and investment accounts', () => {
    expect(resolveImportedTransactionType(-100, 'TFSA')).toBe('EXPENSE');
    expect(resolveImportedTransactionType(100, 'RRSP')).toBe('INCOME');
    expect(resolveImportedTransactionType(-100, 'INVESTMENT')).toBe('EXPENSE');
  });
});

describe('parseCsvAmount', () => {
  it('reads plain, signed, currency-formatted and thousands-separated values', () => {
    expect(parseCsvAmount('42.5')).toBe(42.5);
    expect(parseCsvAmount('-42.50')).toBe(-42.5);
    expect(parseCsvAmount('$1,234.56')).toBe(1234.56);
    expect(parseCsvAmount(' 1 234.56 ')).toBe(1234.56);
  });

  it('reads accounting-style parentheses as negative', () => {
    expect(parseCsvAmount('(45.00)')).toBe(-45);
  });

  it('is null for a missing, blank or non-numeric cell', () => {
    expect(parseCsvAmount(undefined)).toBeNull();
    expect(parseCsvAmount('')).toBeNull();
    expect(parseCsvAmount('   ')).toBeNull();
    expect(parseCsvAmount('n/a')).toBeNull();
  });
});

describe('resolveSplitColumnAmount', () => {
  it('imports a credit as income and a debit as spending', () => {
    expect(resolveSplitColumnAmount('100.00', '')).toEqual({ amount: 100, type: 'INCOME' });
    expect(resolveSplitColumnAmount('', '25.10')).toEqual({ amount: 25.1, type: 'EXPENSE' });
  });

  it('treats a negative debit the same as a positive one', () => {
    expect(resolveSplitColumnAmount('', '-25.10')).toEqual({ amount: 25.1, type: 'EXPENSE' });
  });

  it('imports the net when both columns have a value', () => {
    expect(resolveSplitColumnAmount('100', '30')).toEqual({ amount: 70, type: 'INCOME' });
    expect(resolveSplitColumnAmount('10', '30')).toEqual({ amount: 20, type: 'EXPENSE' });
  });

  it('is null when neither column has a value, so the row is dropped', () => {
    expect(resolveSplitColumnAmount('', '')).toBeNull();
    expect(resolveSplitColumnAmount(undefined, '0.00')).toBeNull();
  });
});

describe('guessSplitColumns', () => {
  it('finds common credit and debit header names', () => {
    expect(guessSplitColumns(['Date', 'Description', 'Debit', 'Credit'])).toEqual({
      credit: 'Credit',
      debit: 'Debit',
    });
    expect(guessSplitColumns(['Date', 'Withdrawals', 'Deposits'])).toEqual({
      credit: 'Deposits',
      debit: 'Withdrawals',
    });
  });

  it('leaves a column blank when nothing matches', () => {
    expect(guessSplitColumns(['Date', 'Amount'])).toEqual({ credit: '', debit: '' });
  });
});
