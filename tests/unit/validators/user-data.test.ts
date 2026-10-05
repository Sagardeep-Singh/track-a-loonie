import { describe, expect, it } from 'vitest';
import {
  MAX_IMPORT_RECORDS,
  USER_DATA_FORMAT_VERSION,
  userDataFileSchema,
} from '@/lib/validators/user-data';

const ACCOUNT = {
  id: 'acc-1',
  name: 'Checking',
  type: 'CHECKING',
  startingBalance: '0.00',
  statementDay: null,
  createdAt: '2026-01-01T00:00:00.000Z',
};

const CATEGORY = {
  id: 'cat-1',
  name: 'Groceries',
  isDefault: false,
  createdAt: '2026-01-01T00:00:00.000Z',
};

const EXPENSE = {
  id: 'tx-expense',
  accountId: 'acc-1',
  categoryId: 'cat-1',
  amount: '50.00',
  type: 'EXPENSE',
  date: '2026-01-05T00:00:00.000Z',
  payee: 'Store',
  note: null,
  importBatchId: null,
  isPayment: false,
  isTransfer: false,
  transferMatchId: null,
  isReimbursable: true,
  reimbursementExpectedAmount: '50.00',
  reimbursementCompletedAt: null,
  skippedAt: null,
  createdAt: '2026-01-05T00:00:00.000Z',
};

const INCOME = {
  ...EXPENSE,
  id: 'tx-income',
  type: 'INCOME',
  isReimbursable: false,
  reimbursementExpectedAmount: null,
  categoryId: null,
};

// `structuredClone` matters here: many tests mutate `file.data...` in place,
// and without a deep clone those mutations would leak into every other
// test's shared ACCOUNT/CATEGORY/EXPENSE/INCOME constant.
const validFile = (): unknown =>
  structuredClone({
    formatVersion: USER_DATA_FORMAT_VERSION,
    exportedAt: '2026-01-01T00:00:00.000Z',
    user: { email: 'a@example.com', name: 'A' },
    data: {
      accounts: [ACCOUNT],
      categories: [CATEGORY],
      importBatches: [],
      transactions: [EXPENSE, INCOME],
      budgets: [],
      categoryRules: [],
      reimbursementLinks: [
        {
          id: 'link-1',
          expenseTransactionId: 'tx-expense',
          incomeTransactionId: 'tx-income',
          amount: '50.00',
          createdAt: '2026-01-06T00:00:00.000Z',
        },
      ],
    },
  });

describe('userDataFileSchema', () => {
  it('accepts a well-formed file', () => {
    const result = userDataFileSchema.safeParse(validFile());
    expect(result.success).toBe(true);
  });

  it('rejects a different format version', () => {
    const file = validFile() as { formatVersion: number };
    file.formatVersion = 3;
    const result = userDataFileSchema.safeParse(file);
    expect(result.success).toBe(false);
    expect(result.error?.issues[0].message).toBe(
      'This file was made by a different version of Track a Loonie.',
    );
  });

  it('rejects an unknown top-level key', () => {
    const file = validFile() as Record<string, unknown>;
    file.extra = 'nope';
    expect(userDataFileSchema.safeParse(file).success).toBe(false);
  });

  it('rejects userId inside a model array', () => {
    const file = validFile() as { data: { accounts: Record<string, unknown>[] } };
    file.data.accounts[0].userId = 'someone-else';
    expect(userDataFileSchema.safeParse(file).success).toBe(false);
  });

  it('rejects a negative amount', () => {
    const file = validFile() as { data: { transactions: { amount: string }[] } };
    file.data.transactions[0].amount = '-50.00';
    expect(userDataFileSchema.safeParse(file).success).toBe(false);
  });

  it('accepts a negative startingBalance (a card with a balance owed)', () => {
    const file = validFile() as { data: { accounts: { startingBalance: string }[] } };
    file.data.accounts[0].startingBalance = '-25.00';
    expect(userDataFileSchema.safeParse(file).success).toBe(true);
  });

  it('rejects more records than the cap', () => {
    const file = validFile() as { data: { categoryRules: unknown[] } };
    file.data.categoryRules = Array.from({ length: MAX_IMPORT_RECORDS + 1 }, (_, i) => ({
      id: `rule-${i}`,
      categoryId: 'cat-1',
      matchText: 'x',
      priority: 0,
    }));
    expect(userDataFileSchema.safeParse(file).success).toBe(false);
  });

  describe('referential integrity', () => {
    it('rejects a transaction referencing an unknown account', () => {
      const file = validFile() as { data: { transactions: { accountId: string }[] } };
      file.data.transactions[0].accountId = 'no-such-account';
      expect(userDataFileSchema.safeParse(file).success).toBe(false);
    });

    it('rejects a transaction referencing an unknown category', () => {
      const file = validFile() as { data: { transactions: { categoryId: string | null }[] } };
      file.data.transactions[0].categoryId = 'no-such-category';
      expect(userDataFileSchema.safeParse(file).success).toBe(false);
    });

    it('rejects a budget referencing an unknown category', () => {
      const file = validFile() as { data: { budgets: unknown[] } };
      file.data.budgets = [
        { id: 'b1', categoryId: 'no-such-category', month: 202601, limitAmount: '10.00' },
      ];
      expect(userDataFileSchema.safeParse(file).success).toBe(false);
    });

    it('rejects a reimbursement link referencing an unknown transaction', () => {
      const file = validFile() as {
        data: { reimbursementLinks: { expenseTransactionId: string }[] };
      };
      file.data.reimbursementLinks[0].expenseTransactionId = 'no-such-tx';
      expect(userDataFileSchema.safeParse(file).success).toBe(false);
    });
  });

  describe('uniqueness', () => {
    it('rejects a duplicate id within one array', () => {
      const file = validFile() as { data: { accounts: unknown[] } };
      file.data.accounts.push(ACCOUNT);
      expect(userDataFileSchema.safeParse(file).success).toBe(false);
    });

    it('rejects two categories with the same name', () => {
      const file = validFile() as { data: { categories: unknown[] } };
      file.data.categories.push({ ...CATEGORY, id: 'cat-2' });
      expect(userDataFileSchema.safeParse(file).success).toBe(false);
    });

    it('rejects two budgets for the same category and month', () => {
      const file = validFile() as { data: { budgets: unknown[] } };
      file.data.budgets = [
        { id: 'b1', categoryId: 'cat-1', month: 202601, limitAmount: '10.00' },
        { id: 'b2', categoryId: 'cat-1', month: 202601, limitAmount: '20.00' },
      ];
      expect(userDataFileSchema.safeParse(file).success).toBe(false);
    });

    it('rejects two reimbursement links between the same two transactions', () => {
      const file = validFile() as { data: { reimbursementLinks: unknown[] } };
      file.data.reimbursementLinks.push({
        id: 'link-2',
        expenseTransactionId: 'tx-expense',
        incomeTransactionId: 'tx-income',
        amount: '1.00',
        createdAt: '2026-01-07T00:00:00.000Z',
      });
      expect(userDataFileSchema.safeParse(file).success).toBe(false);
    });
  });

  describe('domain invariants', () => {
    it('rejects isReimbursable true with no expected amount', () => {
      const file = validFile() as {
        data: {
          transactions: { isReimbursable: boolean; reimbursementExpectedAmount: string | null }[];
        };
      };
      file.data.transactions[0].reimbursementExpectedAmount = null;
      expect(userDataFileSchema.safeParse(file).success).toBe(false);
    });

    it('rejects reimbursementExpectedAmount above the transaction amount', () => {
      const file = validFile() as {
        data: { transactions: { amount: string; reimbursementExpectedAmount: string | null }[] };
      };
      file.data.transactions[0].reimbursementExpectedAmount = '999.00';
      expect(userDataFileSchema.safeParse(file).success).toBe(false);
    });

    it('rejects a reimbursable expense that is also a transfer', () => {
      const file = validFile() as { data: { transactions: { isTransfer: boolean }[] } };
      file.data.transactions[0].isTransfer = true;
      expect(userDataFileSchema.safeParse(file).success).toBe(false);
    });

    it('rejects reimbursementCompletedAt set on a non-reimbursable transaction', () => {
      const file = validFile() as {
        data: {
          transactions: {
            isReimbursable: boolean;
            reimbursementExpectedAmount: string | null;
            reimbursementCompletedAt: string | null;
          }[];
        };
      };
      file.data.transactions[0].isReimbursable = false;
      file.data.transactions[0].reimbursementExpectedAmount = null;
      file.data.transactions[0].reimbursementCompletedAt = '2026-01-10T00:00:00.000Z';
      expect(userDataFileSchema.safeParse(file).success).toBe(false);
    });

    it('rejects a reimbursement link whose expense leg is not a reimbursable expense', () => {
      const file = validFile() as {
        data: {
          transactions: { isReimbursable: boolean; reimbursementExpectedAmount: string | null }[];
        };
      };
      file.data.transactions[0].isReimbursable = false;
      file.data.transactions[0].reimbursementExpectedAmount = null;
      expect(userDataFileSchema.safeParse(file).success).toBe(false);
    });

    it("rejects a linked total that exceeds the expense's expected reimbursement", () => {
      const file = validFile() as { data: { reimbursementLinks: { amount: string }[] } };
      file.data.reimbursementLinks[0].amount = '999.00';
      expect(userDataFileSchema.safeParse(file).success).toBe(false);
    });

    it('rejects a transferMatchId shared by three or more transactions', () => {
      const file = validFile() as {
        data: { transactions: unknown[]; reimbursementLinks: unknown[] };
      };
      file.data.transactions = [
        {
          ...EXPENSE,
          isReimbursable: false,
          reimbursementExpectedAmount: null,
          transferMatchId: 'm1',
        },
        { ...INCOME, id: 'tx-income-2', transferMatchId: 'm1' },
        { ...INCOME, id: 'tx-income-3', transferMatchId: 'm1' },
      ];
      file.data.reimbursementLinks = [] as never[];
      expect(userDataFileSchema.safeParse(file).success).toBe(false);
    });

    it('allows a transferMatchId shared by exactly two transactions', () => {
      const file = validFile() as {
        data: { transactions: unknown[]; reimbursementLinks: unknown[] };
      };
      file.data.transactions = [
        {
          ...EXPENSE,
          isReimbursable: false,
          reimbursementExpectedAmount: null,
          transferMatchId: 'm1',
        },
        { ...INCOME, transferMatchId: 'm1' },
      ];
      file.data.reimbursementLinks = [];
      expect(userDataFileSchema.safeParse(file).success).toBe(true);
    });
  });

  describe('spread fields', () => {
    const withSpread = (patch: Record<string, unknown>): unknown => {
      const file = validFile() as {
        data: { transactions: Record<string, unknown>[]; reimbursementLinks: unknown[] };
      };
      Object.assign(file.data.transactions[0], {
        isReimbursable: false,
        reimbursementExpectedAmount: null,
        ...patch,
      });
      file.data.transactions[0].id = 'tx-plain';
      file.data.reimbursementLinks = [];
      return file;
    };

    it('defaults missing spread fields to null for older exports', () => {
      const result = userDataFileSchema.safeParse(validFile());
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.data.transactions[0].spreadStartMonth).toBeNull();
        expect(result.data.data.transactions[0].spreadMonths).toBeNull();
      }
    });

    it('accepts a spread expense', () => {
      const result = userDataFileSchema.safeParse(
        withSpread({ spreadStartMonth: 202601, spreadMonths: 12 }),
      );
      expect(result.success).toBe(true);
    });

    it('rejects half a spread pair', () => {
      expect(userDataFileSchema.safeParse(withSpread({ spreadStartMonth: 202601 })).success).toBe(
        false,
      );
    });

    it('rejects a spread on income or a reimbursable expense', () => {
      expect(
        userDataFileSchema.safeParse(
          withSpread({ type: 'INCOME', spreadStartMonth: 202601, spreadMonths: 12 }),
        ).success,
      ).toBe(false);
      expect(
        userDataFileSchema.safeParse(
          withSpread({
            isReimbursable: true,
            reimbursementExpectedAmount: '10.00',
            spreadStartMonth: 202601,
            spreadMonths: 12,
          }),
        ).success,
      ).toBe(false);
    });

    it('rejects an out-of-range month count or a malformed start month', () => {
      expect(
        userDataFileSchema.safeParse(withSpread({ spreadStartMonth: 202601, spreadMonths: 25 }))
          .success,
      ).toBe(false);
      expect(
        userDataFileSchema.safeParse(withSpread({ spreadStartMonth: 202613, spreadMonths: 12 }))
          .success,
      ).toBe(false);
    });
  });
});

describe('userDataFileSchema zero-based fields', () => {
  const withZbb = (): Record<string, unknown> & { data: Record<string, unknown> } => {
    const file = validFile() as Record<string, unknown> & { data: Record<string, unknown> };
    file.data.categoryAssignments = [
      { id: 'a-1', categoryId: 'cat-1', month: 202601, amount: '-25.00' },
    ];
    file.data.budgetSettings = { mode: 'ZERO_BASED', zbbStartMonth: 202601 };
    return file;
  };

  it('still accepts a v1 file without the zero-based fields', () => {
    const file = validFile() as { formatVersion: number };
    file.formatVersion = 1;
    expect(userDataFileSchema.safeParse(file).success).toBe(true);
  });

  it('accepts assignments (negative allowed) and budget settings', () => {
    expect(userDataFileSchema.safeParse(withZbb()).success).toBe(true);
  });

  it('rejects an assignment pointing at an unknown category', () => {
    const file = withZbb();
    (file.data.categoryAssignments as { categoryId: string }[])[0].categoryId = 'nope';
    expect(userDataFileSchema.safeParse(file).success).toBe(false);
  });

  it('rejects two assignments for the same category and month', () => {
    const file = withZbb();
    const rows = file.data.categoryAssignments as { id: string }[];
    rows.push({ ...rows[0], id: 'a-2' });
    expect(userDataFileSchema.safeParse(file).success).toBe(false);
  });
});
