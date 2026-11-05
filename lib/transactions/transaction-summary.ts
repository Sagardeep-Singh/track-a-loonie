import type { FrontendTransaction } from '@/lib/services/transactions';

export type TransactionSummary = {
  count: number;
  credit: number;
  debit: number;
  net: number;
  payments: number;
  transfers: number;
  /** the INCOME-side part of `payments` / `transfers`; the rest is outflow */
  paymentsIncome: number;
  transfersIncome: number;
  reimbursementIncome: number;
};

export type TotalsInclusion = { payments: boolean; transfers: boolean };

type SummaryInput = Pick<
  FrontendTransaction,
  'amount' | 'type' | 'isPayment' | 'isTransfer' | 'isReimbursementIncome'
> &
  Partial<
    Pick<
      FrontendTransaction,
      | 'isReimbursable'
      | 'reimbursementExpectedAmount'
      | 'reimbursementLinkedTotal'
      | 'reimbursementCompletedManually'
      | 'reimbursementIncomeLinkedTotal'
    >
  >;

/** What's been paid back on a reimbursable expense (netted only with the
 * expense-month setting): the linked total, or the full expected amount once
 * the user manually marks it fully reimbursed. Mirrors listReimbursedAmounts
 * so Debit matches Overview's Out. */
const reimbursedAmount = (t: SummaryInput): number => {
  if (!t.isReimbursable) return 0;
  const linked = Number(t.reimbursementLinkedTotal ?? 0);
  return t.reimbursementCompletedManually
    ? Math.max(linked, Number(t.reimbursementExpectedAmount ?? 0))
    : linked;
};

/** The part of an income linked as reimbursement. Only that part is the
 * user's own money coming back; the rest is still ordinary income. Falls
 * back to the whole amount when the linked total isn't provided. */
const reimbursementIncomeAmount = (t: SummaryInput, amount: number): number =>
  Math.min(amount, Number(t.reimbursementIncomeLinkedTotal ?? amount));

/** Payments toward a credit card's balance settle the *previous* statement,
 * and both legs of a transfer between the user's own accounts are money that
 * never left the ledger, so neither counts toward this period's
 * credit/debit/net; they're reported separately instead. By default
 * (`inExpenseMonth` false) an expense counts in full in Debit and a
 * reimbursement is ordinary Credit when it arrives. With the expense-month
 * setting each expense counts net of what's been reimbursed, clamped at 0,
 * and only the unlinked part of a reimbursement income is credit; the linked
 * part is reported separately. */
export const summarizeTransactions = (
  list: SummaryInput[],
  { inExpenseMonth = true }: { inExpenseMonth?: boolean } = {},
): TransactionSummary => {
  const summary = list.reduce(
    (acc, t) => {
      const amount = Number(t.amount);
      // isPayment is checked first so a card payment keeps its existing
      // "Payments (excluded)" treatment once transfer matching also flags it
      if (t.isPayment) {
        acc.payments += amount;
        if (t.type === 'INCOME') acc.paymentsIncome += amount;
      } else if (t.isTransfer) {
        acc.transfers += amount;
        if (t.type === 'INCOME') acc.transfersIncome += amount;
      } else if (t.isReimbursementIncome && inExpenseMonth) {
        const reimbursed = reimbursementIncomeAmount(t, amount);
        acc.reimbursementIncome += reimbursed;
        acc.credit += amount - reimbursed;
      } else if (t.type === 'INCOME') {
        acc.credit += amount;
      } else {
        acc.debit += Math.max(0, amount - (inExpenseMonth ? reimbursedAmount(t) : 0));
      }
      return acc;
    },
    {
      credit: 0,
      debit: 0,
      payments: 0,
      transfers: 0,
      paymentsIncome: 0,
      transfersIncome: 0,
      reimbursementIncome: 0,
    },
  );
  return { ...summary, count: list.length, net: summary.credit - summary.debit };
};

/** Folds payments and/or transfers back into credit/debit/net, each by its
 * own direction (income legs into credit, expense legs into debit). */
export const includeInTotals = (
  summary: TransactionSummary,
  inclusion: TotalsInclusion,
): TransactionSummary => {
  let { credit, debit } = summary;
  if (inclusion.payments) {
    credit += summary.paymentsIncome;
    debit += summary.payments - summary.paymentsIncome;
  }
  if (inclusion.transfers) {
    credit += summary.transfersIncome;
    debit += summary.transfers - summary.transfersIncome;
  }
  return { ...summary, credit, debit, net: credit - debit };
};
