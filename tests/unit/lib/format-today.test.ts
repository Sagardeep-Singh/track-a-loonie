import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { currentMonthNumber, daysElapsedInMonth } from '@/lib/format';

describe('currentMonthNumber / daysElapsedInMonth in a timezone', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // 7pm EST on Nov 30
    vi.setSystemTime(new Date('2026-12-01T00:00:00.000Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("uses the viewer's month, not UTC's", () => {
    expect(currentMonthNumber('America/Toronto')).toBe(202611);
    expect(currentMonthNumber()).toBe(202612);
  });

  it("counts elapsed days on the viewer's clock", () => {
    expect(daysElapsedInMonth(202611, 'America/Toronto')).toBe(30);
    expect(daysElapsedInMonth(202612, 'America/Toronto')).toBe(0);
    expect(daysElapsedInMonth(202612)).toBe(1);
    expect(daysElapsedInMonth(202610, 'America/Toronto')).toBe(31);
  });
});
