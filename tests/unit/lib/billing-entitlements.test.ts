import { describe, expect, it } from 'vitest';
import {
  FREE_ENTITLEMENTS,
  UNLIMITED_ENTITLEMENTS,
  historyFloorMonth,
  monthStartDate,
  parseEntitlementsMetadata,
  readStoredEntitlements,
} from '@/lib/billing/entitlements';
import { formatPlanPrice } from '@/lib/billing/format';

describe('parseEntitlementsMetadata', () => {
  it('reads the Plus metadata into unlimited accounts, all history and every feature', () => {
    expect(
      parseEntitlementsMetadata({
        plan: 'true',
        limit_accounts: 'unlimited',
        history_months: 'all',
        feature_trends: 'true',
        feature_reimbursements: 'true',
        feature_statement_cycles: 'true',
        feature_push_reminders: 'TRUE',
      }),
    ).toEqual(UNLIMITED_ENTITLEMENTS);
  });

  it('reads numeric limits', () => {
    const result = parseEntitlementsMetadata({ limit_accounts: '5', history_months: '24' });
    expect(result.limits.accounts).toBe(5);
    expect(result.historyMonths).toBe(24);
  });

  it('falls back to Free for missing keys', () => {
    expect(parseEntitlementsMetadata({})).toEqual(FREE_ENTITLEMENTS);
  });

  it('falls back to Free for malformed values instead of granting more', () => {
    const result = parseEntitlementsMetadata({
      limit_accounts: 'lots',
      history_months: '-3',
      feature_trends: 'yes',
    });
    expect(result).toEqual(FREE_ENTITLEMENTS);
  });
});

describe('readStoredEntitlements', () => {
  it('returns a valid stored shape unchanged', () => {
    expect(readStoredEntitlements(UNLIMITED_ENTITLEMENTS)).toEqual(UNLIMITED_ENTITLEMENTS);
  });

  it('falls back to Free for an unreadable value', () => {
    expect(readStoredEntitlements({ limits: 'nope' })).toEqual(FREE_ENTITLEMENTS);
    expect(readStoredEntitlements(null)).toEqual(FREE_ENTITLEMENTS);
  });
});

describe('historyFloorMonth', () => {
  it('counts the current month as the first of the window', () => {
    expect(historyFloorMonth(FREE_ENTITLEMENTS, new Date('2026-11-05T12:00:00Z'))).toBe(202512);
  });

  it('crosses a year boundary', () => {
    expect(historyFloorMonth(FREE_ENTITLEMENTS, new Date('2026-01-31T23:59:59Z'))).toBe(202502);
  });

  it('is null for unlimited history', () => {
    expect(historyFloorMonth(UNLIMITED_ENTITLEMENTS, new Date())).toBeNull();
  });
});

describe('monthStartDate', () => {
  it('is UTC midnight on the first', () => {
    expect(monthStartDate(202512).toISOString()).toBe('2025-12-01T00:00:00.000Z');
  });
});

describe('formatPlanPrice', () => {
  it('matches the pricing page format', () => {
    expect(formatPlanPrice(400, 'cad')).toBe('C$4');
    expect(formatPlanPrice(450, 'CAD')).toBe('C$4.50');
    expect(formatPlanPrice(1000, 'eur')).toBe('EUR 10');
  });
});
