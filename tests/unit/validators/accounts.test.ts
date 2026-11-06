import { describe, expect, it } from 'vitest';
import { createAccountSchema, createBalanceUpdateSchema } from '@/lib/validators/accounts';

describe('createBalanceUpdateSchema', () => {
  it('accepts a balance with a calendar date and trims the note', () => {
    const parsed = createBalanceUpdateSchema.parse({
      balance: '6200.50',
      date: '2026-01-31',
      note: '  Statement  ',
    });

    expect(parsed).toEqual({
      balance: 6200.5,
      date: new Date('2026-01-31T00:00:00.000Z'),
      note: 'Statement',
    });
  });

  it('accepts a negative balance', () => {
    expect(createBalanceUpdateSchema.parse({ balance: '-25', date: '2026-01-31' }).balance).toBe(
      -25,
    );
  });

  it('rejects a missing, empty or non-numeric balance', () => {
    expect(createBalanceUpdateSchema.safeParse({ date: '2026-01-31' }).success).toBe(false);
    expect(createBalanceUpdateSchema.safeParse({ balance: '', date: '2026-01-31' }).success).toBe(
      false,
    );
    expect(
      createBalanceUpdateSchema.safeParse({ balance: 'abc', date: '2026-01-31' }).success,
    ).toBe(false);
  });

  it('rejects an invalid or future date', () => {
    expect(createBalanceUpdateSchema.safeParse({ balance: 1, date: '2026-02-30' }).success).toBe(
      false,
    );
    const future = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    expect(createBalanceUpdateSchema.safeParse({ balance: 1, date: future }).success).toBe(false);
  });

  it('rejects a note over 200 characters', () => {
    expect(
      createBalanceUpdateSchema.safeParse({ balance: 1, date: '2026-01-31', note: 'x'.repeat(201) })
        .success,
    ).toBe(false);
  });
});

describe('createAccountSchema', () => {
  it('rejects an on-budget account that tracks its balance', () => {
    expect(
      createAccountSchema.safeParse({
        name: 'TFSA',
        type: 'TFSA',
        tracksBalance: true,
        onBudget: true,
      }).success,
    ).toBe(false);
  });
});
