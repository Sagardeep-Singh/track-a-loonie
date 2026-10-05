import { describe, expect, it, vi } from 'vitest';
import type { Prisma } from '@prisma/client';
import {
  DEFAULT_TRANSACTION_FILTERS,
  matchesTransactionFilters,
  type TransactionFilters,
} from '@/lib/transactions/transaction-filters';
import type { FrontendTransaction } from '@/lib/services/transactions';

// buildTransactionWhere is pure, but its module imports the Prisma singleton.
vi.mock('@/lib/db/prisma', () => ({ prisma: {} }));

const { buildTransactionWhere, matchesDeferredPayee } =
  await import('@/lib/services/transactionsPage');

/**
 * Parity: the server predicate (`buildTransactionWhere` + the JS payee half
 * `matchesDeferredPayee`) must select exactly the rows the client-side oracle
 * `matchesTransactionFilters` selects, for every filter and combination.
 *
 * `buildTransactionWhere` returns a Prisma where-graph, not a boolean, so this
 * file carries a tiny interpreter for exactly the clause shapes the
 * architecture's clause table declares. It THROWS on anything else — an
 * interpreter that treated an unknown clause as "no constraint" would hide
 * precisely the drift this suite exists to catch.
 */

type Row = FrontendTransaction;

const fail = (what: string, clause: unknown): never => {
  throw new Error(`parity interpreter: unsupported ${what}: ${JSON.stringify(clause)}`);
};

const evalClause = (row: Row, clause: Record<string, unknown>): boolean => {
  const keys = Object.keys(clause);
  if (keys.length !== 1) return fail('multi-key AND entry', clause);
  const [key] = keys;
  const value = clause[key] as Record<string, unknown> | string | boolean | null;

  switch (key) {
    case 'payee': {
      const v = value as { contains?: unknown; mode?: unknown };
      if (Object.keys(v).sort().join() !== 'contains,mode' || v.mode !== 'insensitive') {
        return fail('payee clause', clause);
      }
      return (row.payee ?? '').toLowerCase().includes(String(v.contains).toLowerCase());
    }
    case 'accountId': {
      const v = value as { in?: unknown };
      if (Object.keys(v).join() !== 'in' || !Array.isArray(v.in)) return fail('accountId', clause);
      return v.in.includes(row.accountId);
    }
    case 'categoryId': {
      if (value === null) return row.categoryId === null;
      const v = value as { in?: unknown };
      if (Object.keys(v).join() !== 'in' || !Array.isArray(v.in)) {
        return fail('categoryId', clause);
      }
      // SQL `IN` never matches NULL
      return row.categoryId !== null && v.in.includes(row.categoryId);
    }
    case 'date': {
      const v = value as { gte?: unknown; lt?: unknown };
      const date = new Date(row.date).getTime();
      const ks = Object.keys(v);
      if (ks.length !== 1) return fail('date clause', clause);
      if (v.gte instanceof Date) return date >= v.gte.getTime();
      if (v.lt instanceof Date) return date < v.lt.getTime();
      return fail('date clause', clause);
    }
    case 'type':
      if (value !== 'INCOME' && value !== 'EXPENSE') return fail('type', clause);
      return row.type === value;
    case 'amount': {
      const v = value as { gte?: unknown; lte?: unknown };
      const ks = Object.keys(v);
      if (ks.length !== 1) return fail('amount clause', clause);
      if (typeof v.gte === 'number') return Number(row.amount) >= v.gte;
      if (typeof v.lte === 'number') return Number(row.amount) <= v.lte;
      return fail('amount clause', clause);
    }
    case 'id': {
      const v = value as { in?: unknown };
      if (Object.keys(v).join() !== 'in' || !Array.isArray(v.in)) return fail('id', clause);
      return v.in.includes(row.id);
    }
    case 'isTransfer':
    case 'isPayment':
      if (typeof value !== 'boolean') return fail(key, clause);
      return row[key] === value;
    default:
      return fail('key', clause);
  }
};

const evalWhere = (row: Row, where: Prisma.TransactionWhereInput): boolean => {
  const { userId, AND, ...rest } = where as { userId?: unknown; AND?: unknown };
  if (Object.keys(rest).length > 0) return fail('top-level key', rest);
  if (userId !== 'user-1') return fail('userId', where);
  if (AND === undefined) return true;
  if (!Array.isArray(AND) || AND.length === 0) return fail('AND', AND);
  return AND.every((c: Record<string, unknown>) => evalClause(row, c));
};

let seq = 0;
const tx = (overrides: Partial<Row> = {}): Row => ({
  id: `t${seq++}`,
  accountId: 'acc-1',
  accountName: 'Checking',
  categoryId: 'cat-1',
  categoryName: 'Food',
  amount: '10.00',
  type: 'EXPENSE',
  date: '2026-06-15T00:00:00.000Z',
  payee: 'Coffee Shop',
  note: null,
  isPayment: false,
  importBatchId: null,
  importBatchFilename: null,
  isTransfer: false,
  transferMatchId: null,
  isReimbursable: false,
  reimbursementExpectedAmount: null,
  reimbursementLinkedTotal: '0.00',
  reimbursementOutstanding: '0.00',
  reimbursementStatus: null,
  reimbursementCompletedManually: false,
  isReimbursementIncome: false,
  reimbursementIncomeLinkedTotal: '0.00',
  spreadStartMonth: null,
  spreadMonths: null,
  spreadMonthlyAmount: null,
  ...overrides,
});

const serverMatches = (rows: Row[], filters: TransactionFilters): string[] => {
  // stands in for listPendingReimbursementExpenseIds, which derives the same status
  const pendingReimbursementIds = rows
    .filter((r) => r.reimbursementStatus === 'PENDING' || r.reimbursementStatus === 'PARTIAL')
    .map((r) => r.id);
  const where = buildTransactionWhere(
    'user-1',
    { filters, mobileSearch: '' },
    { mobile: false, pendingReimbursementIds },
  );
  return rows
    .filter((r) => evalWhere(r, where) && matchesDeferredPayee(r.payee, filters))
    .map((r) => r.id);
};

const clientMatches = (rows: Row[], filters: TransactionFilters): string[] =>
  rows.filter((r) => matchesTransactionFilters(r, filters)).map((r) => r.id);

/** A varied fixture set every case runs against, so each filter sees rows on both sides. */
const fixtures: Row[] = [
  tx({ payee: 'Coffee Shop', amount: '4.50' }),
  tx({ payee: 'COFFEE bar', amount: '20.00', accountId: 'acc-2' }),
  tx({ payee: null, categoryId: null, categoryName: null, amount: '99.99' }),
  tx({ payee: 'Paycheck', type: 'INCOME', amount: '1500.00', categoryId: 'cat-2' }),
  tx({ payee: 'Card payment', type: 'INCOME', isPayment: true, amount: '300.00' }),
  tx({ payee: 'Transfer out', isTransfer: true, amount: '250.00', categoryId: null }),
  tx({ payee: 'Both', isPayment: true, isTransfer: true, amount: '75.00' }),
  tx({ payee: '100% Coffee', amount: '100.00' }),
  tx({ payee: '1000 Coffees', amount: '100.01' }),
  tx({ payee: 'Whole_Foods', amount: '55.10' }),
  tx({ payee: 'WholeXFoods', amount: '55.20' }),
  tx({ date: '2026-06-10T00:00:00.000Z', payee: 'Early' }),
  tx({ date: '2026-06-09T23:59:59.999Z', payee: 'Day before from' }),
  tx({ date: '2026-06-20T23:59:59.999Z', payee: 'End of to day' }),
  tx({ date: '2026-06-21T00:00:00.000Z', payee: 'Day after to' }),
  tx({ date: '2026-06-15T18:30:00.000Z', payee: 'Evening', amount: '20.00' }),
  tx({ amount: '20.00', categoryId: 'cat-2', accountId: 'acc-2' }),
  tx({ payee: 'Other account', accountId: 'acc-3', categoryId: 'cat-3' }),
  tx({ payee: 'Pending reimb', isReimbursable: true, reimbursementStatus: 'PENDING' }),
  tx({ payee: 'Partial reimb', isReimbursable: true, reimbursementStatus: 'PARTIAL' }),
  tx({ payee: 'Complete reimb', isReimbursable: true, reimbursementStatus: 'COMPLETE' }),
];

const cases: [string, Partial<TransactionFilters>][] = [
  ['no filters', {}],
  ['payee', { payee: 'coffee' }],
  ['payee with surrounding whitespace', { payee: '  Coffee  ' }],
  ['payee containing %', { payee: '100%' }],
  ['payee containing _', { payee: 'whole_f' }],
  ['accountIds', { accountIds: ['acc-2'] }],
  ['accountIds (multi)', { accountIds: ['acc-1', 'acc-2'] }],
  ['categoryIds excludes no-category rows', { categoryIds: ['cat-1'] }],
  ['categoryIds (multi)', { categoryIds: ['cat-1', 'cat-2'] }],
  ['from', { from: '2026-06-10' }],
  ['to (inclusive through 23:59:59.999)', { to: '2026-06-20' }],
  ['from + to', { from: '2026-06-10', to: '2026-06-20' }],
  ['from on a non-midnight row day', { from: '2026-06-15' }],
  ['type INCOME', { type: 'INCOME' }],
  ['type EXPENSE', { type: 'EXPENSE' }],
  ['amountMin', { amountMin: '20' }],
  ['amountMax', { amountMax: '20' }],
  ['amountMin + amountMax', { amountMin: '20', amountMax: '100' }],
  ['amountMin unparseable', { amountMin: 'abc' }],
  ['amountMax unparseable', { amountMax: 'abc' }],
  ['both amount bounds unparseable', { amountMin: 'abc', amountMax: 'xyz' }],
  ['hideTransfers', { hideTransfers: true }],
  ['hidePayments', { hidePayments: true }],
  ['uncategorizedOnly', { uncategorizedOnly: true }],
  ['pendingReimbursementsOnly', { pendingReimbursementsOnly: true }],
  ['pendingReimbursementsOnly + payee', { pendingReimbursementsOnly: true, payee: 'partial' }],
  [
    'all three flags together',
    { hideTransfers: true, hidePayments: true, uncategorizedOnly: true },
  ],
  [
    'combined: payee + account + amount range',
    { payee: 'coffee', accountIds: ['acc-1'], amountMin: '4', amountMax: '50' },
  ],
  [
    'combined: category + type + date + hideTransfers',
    { categoryIds: ['cat-1', 'cat-2'], type: 'EXPENSE', from: '2026-06-15', hideTransfers: true },
  ],
];

describe('buildTransactionWhere parity with matchesTransactionFilters', () => {
  it.each(cases)('%s', (_name, overrides) => {
    const filters = { ...DEFAULT_TRANSACTION_FILTERS, ...overrides };
    expect(serverMatches(fixtures, filters)).toEqual(clientMatches(fixtures, filters));
  });

  it('really narrows in every non-trivial case (guards against a vacuous oracle)', () => {
    for (const [name, overrides] of cases) {
      const filters = { ...DEFAULT_TRANSACTION_FILTERS, ...overrides };
      const unparseableOnly = name.includes('unparseable');
      if (name === 'no filters' || unparseableOnly) continue;
      expect(clientMatches(fixtures, filters).length, name).toBeLessThan(fixtures.length);
      expect(clientMatches(fixtures, filters).length, name).toBeGreaterThan(0);
    }
  });

  it('pins the day-boundary rows explicitly', () => {
    const filters = { ...DEFAULT_TRANSACTION_FILTERS, from: '2026-06-10', to: '2026-06-20' };
    const payees = (ids: string[]): (string | null)[] =>
      fixtures.filter((r) => ids.includes(r.id)).map((r) => r.payee);
    const matched = payees(serverMatches(fixtures, filters));
    expect(matched).toContain('End of to day');
    expect(matched).toContain('Early');
    expect(matched).not.toContain('Day after to');
    expect(matched).not.toContain('Day before from');
  });

  it('true AND: a row failing only one clause is excluded on both sides', () => {
    const filters = {
      ...DEFAULT_TRANSACTION_FILTERS,
      payee: 'coffee',
      categoryIds: ['cat-1'],
      amountMax: '50',
    };
    const rows = [
      tx({ id: 'pass', payee: 'Coffee', amount: '10.00' }),
      tx({ id: 'fails-amount', payee: 'Coffee', amount: '60.00' }),
      tx({ id: 'fails-category', payee: 'Coffee', categoryId: 'cat-9' }),
      tx({ id: 'fails-payee', payee: 'Tea', amount: '10.00' }),
    ];
    expect(serverMatches(rows, filters)).toEqual(['pass']);
    expect(clientMatches(rows, filters)).toEqual(['pass']);
  });

  it('the interpreter refuses clause shapes it does not know', () => {
    const row = tx();
    expect(() => evalWhere(row, { userId: 'user-1', OR: [] })).toThrow(/top-level/);
    expect(() => evalWhere(row, { userId: 'user-1', AND: [{ NOT: { type: 'INCOME' } }] })).toThrow(
      /unsupported key/,
    );
    expect(() => evalWhere(row, { userId: 'user-1', AND: [{ payee: { contains: 'x' } }] })).toThrow(
      /payee/,
    );
  });
});
