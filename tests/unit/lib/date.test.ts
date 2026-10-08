import { describe, expect, it } from 'vitest';

import { daysInMonth, fromDateKey, monthRange, toDateKey, todayDateKey } from '@/lib/date';

describe('monthRange', () => {
  it('returns the month as a half-open UTC range', () => {
    const { start, end } = monthRange(202603);
    expect(start.toISOString()).toBe('2026-03-01T00:00:00.000Z');
    expect(end.toISOString()).toBe('2026-04-01T00:00:00.000Z');
  });

  it('rolls the year over for December', () => {
    const { start, end } = monthRange(202612);
    expect(start.toISOString()).toBe('2026-12-01T00:00:00.000Z');
    expect(end.toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });

  it('uses UTC midnight boundaries regardless of the host timezone', () => {
    const { start } = monthRange(202601);
    expect(start.getUTCHours()).toBe(0);
    expect(start.getUTCDate()).toBe(1);
  });
});

describe('daysInMonth', () => {
  it('counts 31-, 30- and 28-day months', () => {
    expect(daysInMonth(202601)).toBe(31);
    expect(daysInMonth(202604)).toBe(30);
    expect(daysInMonth(202602)).toBe(28);
  });

  it('counts 29 days in a leap February', () => {
    expect(daysInMonth(202402)).toBe(29);
  });

  it('counts December without spilling into the next year', () => {
    expect(daysInMonth(202612)).toBe(31);
  });
});

describe('toDateKey', () => {
  it('reads the UTC calendar day', () => {
    expect(toDateKey(new Date('2026-10-05T00:00:00.000Z'))).toBe('2026-10-05');
    expect(toDateKey(new Date('2026-10-05T23:59:59.999Z'))).toBe('2026-10-05');
  });
});

describe('fromDateKey', () => {
  it('returns UTC midnight for a real date', () => {
    expect(fromDateKey('2026-10-05')?.toISOString()).toBe('2026-10-05T00:00:00.000Z');
    expect(fromDateKey('2028-02-29')?.toISOString()).toBe('2028-02-29T00:00:00.000Z');
  });

  it('rejects days that do not exist and other shapes', () => {
    expect(fromDateKey('2026-02-30')).toBeNull();
    expect(fromDateKey('2026-13-01')).toBeNull();
    expect(fromDateKey('2026-10-5')).toBeNull();
    expect(fromDateKey('10/05/2026')).toBeNull();
    expect(fromDateKey('2026-10-05T00:00:00Z')).toBeNull();
    expect(fromDateKey('')).toBeNull();
  });
});

describe('todayDateKey', () => {
  it('uses the local calendar day, not the UTC one', () => {
    // built from local parts, so it is 23:30 local wherever the tests run
    const lateEvening = new Date(2026, 9, 5, 23, 30);
    expect(todayDateKey(lateEvening)).toBe('2026-10-05');
    expect(todayDateKey(new Date(2026, 0, 1, 0, 5))).toBe('2026-01-01');
  });
});
