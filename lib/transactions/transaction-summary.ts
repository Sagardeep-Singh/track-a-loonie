import type { FrontendTransaction } from '@/lib/services/transactions';

export type TransactionSummary = {
  count: number;
  credit: number;
  debit: number;
  net: number;
  payments: number;
  transfers: number;
  reimbursementIncome: number;
};

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

/** What's netted from a reimbursable expense's own row. In expense-month mode
 * that's everything paid back: the linked total, or the full expected amount
 * once the user manually marks it fully reimbursed. By default linked money
 * counts where it arrives instead, so only the manual top-up stays on the
 * expense. Mirrors listReimbursedAmounts so Debit matches Overview's Out. */
const reimbursedAmount = (t: SummaryInput, inExpenseMonth: boolean): number => {
  if (!t.isReimbursable) return 0;
  const linked = Number(t.reimbursementLinkedTotal ?? 0);
  const total = t.reimbursementCompletedManually
    ? Math.max(linked, Number(t.reimbursementExpectedAmount ?? 0))
    : linked;
  return inExpenseMonth ? total : total - linked;
};

/** The part of an income linked as reimbursement. Only that part is the
 * user's own money coming back; the rest is still ordinary income. Falls
 * back to the whole amount when the linked total isn't provided. */
const reimbursementIncomeAmount = (t: SummaryInput, amount: number): number =>
  Math.min(amount, Number(t.reimbursementIncomeLinkedTotal ?? amount));

/** Payments toward a credit card's balance settle the *previous* statement,
 * and both legs of a transfer between the user's own accounts are money that
 * never left the ledger, so neither counts toward this period's
 * credit/debit/net; they're reported separately instead. Income linked as a
 * reimbursement only has its linked part moved out of credit. In
 * expense-month mode each expense counts net of what's been reimbursed,
 * clamped at 0, and the linked income is reported separately; by default
 * (`inExpenseMonth` false) the linked income in view comes off Debit instead,
 * like Overview does in the month the money arrives. */
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
      } else if (t.isTransfer) {
        acc.transfers += amount;
      } else if (t.isReimbursementIncome) {
        const reimbursed = reimbursementIncomeAmount(t, amount);
        acc.reimbursementIncome += reimbursed;
        acc.credit += amount - reimbursed;
      } else if (t.type === 'INCOME') {
        acc.credit += amount;
      } else {
        acc.debit += Math.max(0, amount - reimbursedAmount(t, inExpenseMonth));
      }
      return acc;
    },
    { credit: 0, debit: 0, payments: 0, transfers: 0, reimbursementIncome: 0 },
  );
  if (!inExpenseMonth) {
    summary.debit = Math.max(0, summary.debit - summary.reimbursementIncome);
    summary.reimbursementIncome = 0;
  }
  return { ...summary, count: list.length, net: summary.credit - summary.debit };
};
