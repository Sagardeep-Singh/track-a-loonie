import { describe, expect, it } from 'vitest';
import {
  detectCsvDateFormat,
  guessSplitColumns,
  parseCsvDate,
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

describe('parseCsvDate', () => {
  it('reads ISO-style dates under YMD, with or without padding or a time', () => {
    expect(parseCsvDate('2026-10-05', 'YMD')).toBe('2026-10-05');
    expect(parseCsvDate('2026/10/5', 'YMD')).toBe('2026-10-05');
    expect(parseCsvDate('2026.10.05', 'YMD')).toBe('2026-10-05');
    expect(parseCsvDate('  2026-10-05 13:45:00 ', 'YMD')).toBe('2026-10-05');
    expect(parseCsvDate('2026-10-05T23:30:00Z', 'YMD')).toBe('2026-10-05');
    expect(parseCsvDate('20261005', 'YMD')).toBe('2026-10-05');
  });

  it('reads the same numeric date month-first or day-first per format', () => {
    expect(parseCsvDate('10/05/2026', 'MDY')).toBe('2026-10-05');
    expect(parseCsvDate('10/05/2026', 'DMY')).toBe('2026-05-10');
    expect(parseCsvDate('1-5-2026', 'MDY')).toBe('2026-01-05');
    expect(parseCsvDate('10/05/2026 1:45 PM', 'MDY')).toBe('2026-10-05');
  });

  it('reads two-digit years as this century', () => {
    expect(parseCsvDate('10/05/26', 'MDY')).toBe('2026-10-05');
    expect(parseCsvDate('05/10/26', 'DMY')).toBe('2026-10-05');
  });

  it('reads month-name dates under any format', () => {
    for (const format of ['YMD', 'MDY', 'DMY'] as const) {
      expect(parseCsvDate('Oct 5, 2026', format)).toBe('2026-10-05');
      expect(parseCsvDate('October 5th 2026', format)).toBe('2026-10-05');
      expect(parseCsvDate('05-Oct-2026', format)).toBe('2026-10-05');
      expect(parseCsvDate('5 Sept. 2026', format)).toBe('2026-09-05');
      expect(parseCsvDate('2026-Oct-05', format)).toBe('2026-10-05');
    }
  });

  it('rejects dates that do not exist instead of rolling them over', () => {
    expect(parseCsvDate('2026-02-30', 'YMD')).toBeNull();
    expect(parseCsvDate('02/30/2026', 'MDY')).toBeNull();
    expect(parseCsvDate('13/13/2026', 'DMY')).toBeNull();
    expect(parseCsvDate('Foo 5, 2026', 'MDY')).toBeNull();
  });

  it('rejects a numeric date in the wrong order for the format', () => {
    expect(parseCsvDate('10/05/2026', 'YMD')).toBeNull();
    expect(parseCsvDate('2026-10-05', 'MDY')).toBeNull();
    expect(parseCsvDate('20261005', 'DMY')).toBeNull();
    expect(parseCsvDate('13/05/2026', 'MDY')).toBeNull();
  });

  it('returns null for blank or non-date cells', () => {
    expect(parseCsvDate(undefined, 'YMD')).toBeNull();
    expect(parseCsvDate('', 'YMD')).toBeNull();
    expect(parseCsvDate('   ', 'MDY')).toBeNull();
    expect(parseCsvDate('Total', 'MDY')).toBeNull();
    expect(parseCsvDate('12345', 'YMD')).toBeNull();
  });
});

describe('detectCsvDateFormat', () => {
  it('detects ISO dates', () => {
    expect(detectCsvDateFormat(['2026-10-05', '2026-10-06'])).toEqual({
      kind: 'detected',
      format: 'YMD',
    });
  });

  it('detects month-first once a day above 12 shows up', () => {
    expect(detectCsvDateFormat(['10/05/2026', '10/13/2026'])).toEqual({
      kind: 'detected',
      format: 'MDY',
    });
  });

  it('detects day-first once a day above 12 shows up', () => {
    expect(detectCsvDateFormat(['05/10/2026', '13/10/2026'])).toEqual({
      kind: 'detected',
      format: 'DMY',
    });
  });

  it('is ambiguous when every date reads both ways', () => {
    expect(detectCsvDateFormat(['10/05/2026', '11/05/2026'])).toEqual({
      kind: 'ambiguous',
      options: ['MDY', 'DMY'],
    });
  });

  it('treats month-name dates as detected', () => {
    expect(detectCsvDateFormat(['Oct 5, 2026', 'Oct 6, 2026']).kind).toBe('detected');
  });

  it('ignores a stray footer line', () => {
    expect(detectCsvDateFormat(['2026-10-05', '2026-10-06', 'Total', undefined])).toEqual({
      kind: 'detected',
      format: 'YMD',
    });
  });

  it('reports a column with no dates', () => {
    expect(detectCsvDateFormat(['Coffee', '', undefined])).toEqual({ kind: 'unrecognized' });
    expect(detectCsvDateFormat([])).toEqual({ kind: 'unrecognized' });
  });
});
