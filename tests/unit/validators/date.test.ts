import { describe, expect, it } from 'vitest';
import { calendarDateSchema, dateKeySchema } from '@/lib/validators/date';

describe('dateKeySchema', () => {
  it('accepts a real YYYY-MM-DD date', () => {
    expect(dateKeySchema.parse(' 2026-10-05 ')).toBe('2026-10-05');
  });

  it.each(['10/05/2026', 'Oct 5, 2026', '2026-02-30', '2026-10-05T00:00:00Z', ''])(
    'rejects %j',
    (value) => {
      expect(dateKeySchema.safeParse(value).success).toBe(false);
    },
  );
});

describe('calendarDateSchema', () => {
  it('turns YYYY-MM-DD into UTC midnight', () => {
    expect(calendarDateSchema.parse('2026-10-05').toISOString()).toBe('2026-10-05T00:00:00.000Z');
  });

  it('reduces an ISO timestamp with a zone to its UTC day', () => {
    expect(calendarDateSchema.parse('2026-10-05T00:00:00.000Z').toISOString()).toBe(
      '2026-10-05T00:00:00.000Z',
    );
    expect(calendarDateSchema.parse('2026-10-05T04:00:00Z').toISOString()).toBe(
      '2026-10-05T00:00:00.000Z',
    );
  });

  it('reduces a Date to its UTC day', () => {
    expect(calendarDateSchema.parse(new Date('2026-10-05T18:30:00Z')).toISOString()).toBe(
      '2026-10-05T00:00:00.000Z',
    );
  });

  it.each([
    '10/05/2026',
    'Oct 5, 2026',
    '2026-02-30',
    // no zone: would be read in the server's local time
    '2026-10-05T00:00:00',
    '',
    'garbage',
  ])('rejects %j', (value) => {
    expect(calendarDateSchema.safeParse(value).success).toBe(false);
  });

  it('rejects an invalid Date', () => {
    expect(calendarDateSchema.safeParse(new Date('nope')).success).toBe(false);
  });
});
