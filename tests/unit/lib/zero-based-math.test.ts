import { describe, expect, it } from 'vitest';
import { computeZbbMonth, targetTopUps, type ZbbCell } from '@/lib/budgets/zero-based-math';

const cents = (dollars: number): number => Math.round(dollars * 100);
const cell = (categoryId: string, month: number, dollars: number): ZbbCell => ({
  categoryId,
  month,
  cents: cents(dollars),
});

describe('computeZbbMonth', () => {
  it('carries leftovers forward and splits carried-in from this month', () => {
    const result = computeZbbMonth({
      month: 202602,
      categoryIds: ['food'],
      assignments: [cell('food', 202601, 600), cell('food', 202602, 580)],
      activity: [cell('food', 202601, 550), cell('food', 202602, 100)],
      onBudgetBalanceCents: cents(1000),
    });
    expect(result.categories).toEqual([
      {
        categoryId: 'food',
        carriedInCents: cents(50),
        assignedCents: cents(580),
        activityCents: cents(100),
        availableCents: cents(530),
      },
    ]);
  });

  it('carries an overspend forward as a negative', () => {
    const result = computeZbbMonth({
      month: 202602,
      categoryIds: ['food'],
      assignments: [cell('food', 202601, 100)],
      activity: [cell('food', 202601, 130)],
      onBudgetBalanceCents: 0,
    });
    expect(result.categories[0].carriedInCents).toBe(cents(-30));
    expect(result.categories[0].availableCents).toBe(cents(-30));
  });

  it('makes Ready to Assign global: future assignments reduce it now', () => {
    const result = computeZbbMonth({
      month: 202601,
      categoryIds: ['rent'],
      assignments: [cell('rent', 202601, 1800), cell('rent', 202602, 1800)],
      activity: [],
      onBudgetBalanceCents: cents(5000),
    });
    expect(result.readyToAssignCents).toBe(cents(1400));
    // only January's assignment shows in January
    expect(result.categories[0].assignedCents).toBe(cents(1800));
  });

  it('counts committed money of categories not shown (still reduces Ready to Assign)', () => {
    const result = computeZbbMonth({
      month: 202601,
      categoryIds: ['a'],
      assignments: [cell('a', 202601, 10), cell('hidden', 202601, 40)],
      activity: [],
      onBudgetBalanceCents: cents(100),
    });
    expect(result.categories.map((c) => c.categoryId)).toEqual(['a']);
    expect(result.readyToAssignCents).toBe(cents(50));
  });

  it('reproduces the 3-month worked example from the plan', () => {
    const jan = 202601;
    const feb = 202602;
    const mar = 202603;
    const categoryIds = [
      'rent',
      'groceries',
      'utilities',
      'transport',
      'fun',
      'carInsurance',
      'medical',
      'vacation',
      'emergency',
    ];
    const assignments: ZbbCell[] = [
      // January: $20,000 starting + $5,000 income, all assigned
      cell('rent', jan, 1800),
      cell('groceries', jan, 600 + 50), // +50 covered from Fun
      cell('utilities', jan, 200),
      cell('transport', jan, 300),
      cell('fun', jan, 400 - 50),
      cell('carInsurance', jan, 400),
      cell('vacation', jan, 1300),
      cell('emergency', jan, 20000),
      // February: $5,000
      cell('rent', feb, 1800),
      cell('groceries', feb, 600 - 10), // 10 moved to utilities
      cell('utilities', feb, 180 + 10),
      cell('transport', feb, 250),
      cell('fun', feb, 350),
      cell('carInsurance', feb, 400),
      cell('vacation', feb, 500),
      cell('emergency', feb, 920),
      // March: $5,000, plus $300 moved from emergency to cover medical
      cell('rent', mar, 1800),
      cell('groceries', mar, 590),
      cell('utilities', mar, 200),
      cell('transport', mar, 300),
      cell('fun', mar, 400),
      cell('carInsurance', mar, 400),
      cell('medical', mar, 300),
      cell('vacation', mar, 500),
      cell('emergency', mar, 810 - 300),
    ];
    const activity: ZbbCell[] = [
      cell('rent', jan, 1800),
      cell('groceries', jan, 650),
      cell('utilities', jan, 180),
      cell('transport', jan, 250),
      cell('fun', jan, 300),
      cell('rent', feb, 1800),
      cell('groceries', feb, 580),
      cell('utilities', feb, 210),
      cell('transport', feb, 300),
      cell('fun', feb, 400),
      cell('rent', mar, 1800),
      cell('groceries', mar, 600),
      cell('utilities', mar, 190),
      cell('transport', mar, 280),
      cell('fun', mar, 350),
      cell('carInsurance', mar, 1200),
      cell('medical', mar, 300),
    ];
    const chequing = 20000 + 3 * 5000 - (3180 + 3290 + 4720);
    expect(chequing).toBe(23810);

    const result = computeZbbMonth({
      month: mar,
      categoryIds,
      assignments,
      activity,
      onBudgetBalanceCents: cents(chequing),
    });
    const available = Object.fromEntries(
      result.categories.map((c) => [c.categoryId, c.availableCents / 100]),
    );
    expect(result.readyToAssignCents).toBe(0);
    expect(available).toEqual({
      rent: 0,
      groceries: 0,
      utilities: 10,
      transport: 20,
      fun: 50,
      carInsurance: 0,
      medical: 0,
      vacation: 2300,
      emergency: 21430,
    });
    const sum = result.categories.reduce((s, c) => s + c.availableCents, 0);
    expect(sum).toBe(cents(chequing));
  });
});

describe('targetTopUps', () => {
  it('tops up to the target counting carried-in money, never negative', () => {
    const result = targetTopUps(
      [
        { categoryId: 'a', carriedInCents: 5000, assignedCents: 0 },
        { categoryId: 'b', carriedInCents: 0, assignedCents: 30000 },
        { categoryId: 'c', carriedInCents: 0, assignedCents: 0 },
      ],
      new Map([
        ['a', 20000],
        ['b', 20000],
      ]),
    );
    expect(result).toEqual([{ categoryId: 'a', topUpCents: 15000 }]);
  });
});
