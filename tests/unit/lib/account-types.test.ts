import { describe, expect, it } from 'vitest';
import {
  ACCOUNT_TYPE_GROUPS,
  ACCOUNT_TYPE_VALUES,
  ACCOUNT_TYPES,
  accountTypeGroup,
  accountTypeLabel,
  accountTypesInGroup,
  defaultOnBudgetFor,
  isLiabilityAccountType,
} from '@/lib/account-types';

describe('account type metadata', () => {
  it('has metadata for every account type and puts each type in exactly one group', () => {
    for (const type of ACCOUNT_TYPE_VALUES) {
      expect(ACCOUNT_TYPES[type].label).toBeTruthy();
    }
    const grouped = ACCOUNT_TYPE_GROUPS.flatMap(accountTypesInGroup);
    expect([...grouped].sort()).toEqual([...ACCOUNT_TYPE_VALUES].sort());
  });

  it('treats credit cards and lines of credit as liabilities and nothing else', () => {
    const liabilities = ACCOUNT_TYPE_VALUES.filter(isLiabilityAccountType);
    expect(liabilities).toEqual(['CREDIT_CARD', 'LINE_OF_CREDIT']);
    expect(isLiabilityAccountType(undefined)).toBe(false);
  });

  it('keeps savings, registered and investment accounts off-budget by default', () => {
    const offBudget = ACCOUNT_TYPE_VALUES.filter((t) => !defaultOnBudgetFor(t));
    expect(offBudget).toEqual([
      'SAVINGS',
      'RRSP',
      'TFSA',
      'FHSA',
      'RESP',
      'RRIF',
      'LIRA',
      'INVESTMENT',
    ]);
  });

  it('groups registered plans together', () => {
    expect(accountTypesInGroup('Registered')).toEqual([
      'RRSP',
      'TFSA',
      'FHSA',
      'RESP',
      'RRIF',
      'LIRA',
    ]);
    expect(accountTypeGroup('INVESTMENT')).toBe('Investment');
    expect(accountTypeGroup('LINE_OF_CREDIT')).toBe('Credit');
  });

  it('falls back gracefully for an unknown type', () => {
    expect(accountTypeLabel('MYSTERY')).toBe('MYSTERY');
    expect(accountTypeGroup('MYSTERY')).toBe('Banking');
    expect(defaultOnBudgetFor('MYSTERY')).toBe(true);
    expect(accountTypeLabel('INVESTMENT')).toBe('Non-registered investment');
  });
});
