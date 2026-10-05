import { describe, expect, it } from 'vitest';
import { addMonths, monthOfDate, monthsBetween } from '@/lib/date';
import { allocateSpread, spreadEndMonth } from '@/lib/spread';
import { formatSpreadMonth, spreadPreview } from '@/lib/transactions/spread-preview';
import { monthInputToYyyymm, yyyymmToMonthInput } from '@/lib/transactions/transaction-payload';

describe('addMonths', () => {
  it('moves within a year', () => {
    expect(addMonths(202603, 2)).toBe(202605);
  });

  it('crosses a year boundary forward and backward', () => {
    expect(addMonths(202611, 3)).toBe(202702);
    expect(addMonths(202602, -3)).toBe(202511);
    expect(addMonths(202601, -1)).toBe(202512);
  });

  it('is a no-op for zero and handles multi-year jumps', () => {
    expect(addMonths(202606, 0)).toBe(202606);
    expect(addMonths(202606, 24)).toBe(202806);
    expect(addMonths(202606, -24)).toBe(202406);
  });
});

describe('monthsBetween / monthOfDate', () => {
  it('counts signed months across years', () => {
    expect(monthsBetween(202606, 202601)).toBe(-5);
    expect(monthsBetween(202511, 202702)).toBe(15);
    expect(monthsBetween(202606, 202606)).toBe(0);
  });

  it('reads the UTC month of a date', () => {
    expect(monthOfDate(new Date('2026-12-31T00:00:00.000Z'))).toBe(202612);
  });
});

describe('spreadEndMonth', () => {
  it('is the last covered month, inclusive', () => {
    expect(spreadEndMonth(202601, 12)).toBe(202612);
    expect(spreadEndMonth(202607, 12)).toBe(202706);
    expect(spreadEndMonth(202612, 2)).toBe(202701);
  });
});

describe('allocateSpread', () => {
  it('splits evenly when the amount divides', () => {
    const shares = allocateSpread(360000, 202601, 12);
    expect(shares).toHaveLength(12);
    expect(shares.every((s) => s.cents === 30000)).toBe(true);
    expect(shares[0].month).toBe(202601);
    expect(shares[11].month).toBe(202612);
  });

  it('gives the remainder cents to the earliest months and always sums back exactly', () => {
    const shares = allocateSpread(10000, 202601, 3);
    expect(shares.map((s) => s.cents)).toEqual([3334, 3333, 3333]);
    expect(shares.reduce((sum, s) => sum + s.cents, 0)).toBe(10000);
  });

  it('handles an amount smaller than the month count', () => {
    const shares = allocateSpread(5, 202601, 12);
    expect(shares.reduce((sum, s) => sum + s.cents, 0)).toBe(5);
    expect(shares.slice(0, 5).every((s) => s.cents === 1)).toBe(true);
    expect(shares.slice(5).every((s) => s.cents === 0)).toBe(true);
  });

  it('covers the 24-month edge across years', () => {
    const shares = allocateSpread(240001, 202511, 24);
    expect(shares[0]).toEqual({ month: 202511, cents: 10001 });
    expect(shares[23]).toEqual({ month: 202710, cents: 10000 });
  });
});

describe('month input helpers', () => {
  it('round-trips YYYYMM and the month input value', () => {
    expect(monthInputToYyyymm('2026-03')).toBe(202603);
    expect(yyyymmToMonthInput(202603)).toBe('2026-03');
  });

  it('rejects blank and malformed values', () => {
    expect(monthInputToYyyymm('')).toBeNull();
    expect(monthInputToYyyymm('2026-13')).toBeNull();
    expect(monthInputToYyyymm('2026-00')).toBeNull();
    expect(monthInputToYyyymm('202603')).toBeNull();
  });
});

describe('spreadPreview', () => {
  it('shows the monthly share and the covered range', () => {
    expect(spreadPreview('3600', '2026-01', '12')).toBe('$300.00 a month, Jan 2026 to Dec 2026');
  });

  it('shows the largest share when it does not divide evenly', () => {
    expect(spreadPreview('100', '2026-11', '3')).toBe('$33.34 a month, Nov 2026 to Jan 2027');
  });

  it('falls back to the range alone before an amount is entered', () => {
    expect(spreadPreview('', '2026-01', '12')).toBe('Over 12 months, Jan 2026 to Dec 2026');
  });

  it('is null while the window is incomplete or out of range', () => {
    expect(spreadPreview('100', '', '12')).toBeNull();
    expect(spreadPreview('100', '2026-01', '')).toBeNull();
    expect(spreadPreview('100', '2026-01', '1')).toBeNull();
    expect(spreadPreview('100', '2026-01', '25')).toBeNull();
    expect(spreadPreview('100', '2026-01', '2.5')).toBeNull();
  });

  it('formats a single month label', () => {
    expect(formatSpreadMonth(202606)).toBe('Jun 2026');
  });
});
