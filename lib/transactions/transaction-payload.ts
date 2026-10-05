export type TransactionFormValues = {
  accountId: string;
  amount: string;
  date: string;
  payee?: string;
  note?: string;
};

export type TransactionPayload = {
  accountId: string;
  categoryId: string | null;
  amount: string;
  type: string;
  date: string;
  payee: string | undefined;
  note: string | undefined;
  isPayment: boolean;
  isTransfer: boolean;
  isReimbursable: boolean;
  reimbursementExpectedAmount: string | undefined;
  /** YYYYMM; null clears a spread (explicitly, so an edit can turn one off) */
  spreadStartMonth: number | null;
  spreadMonths: number | null;
};

/** `<input type="month">` value ("2026-03") to YYYYMM, or null when blank/invalid. */
export const monthInputToYyyymm = (value: string): number | null => {
  const match = /^(\d{4})-(\d{2})$/.exec(value);
  if (!match) return null;
  const month = Number(match[2]);
  if (month < 1 || month > 12) return null;
  return Number(match[1]) * 100 + month;
};

/** YYYYMM to an `<input type="month">` value. */
export const yyyymmToMonthInput = (month: number): string =>
  `${Math.floor(month / 100)}-${String(month % 100).padStart(2, '0')}`;

/**
 * Shapes the /api/transactions request body. Pure so the regression-sensitive
 * rules below are unit-testable: `isPayment` (and, the same way,
 * `isReimbursable` and the spread fields) must be forced false whenever the account/type
 * combination can't take it, even if the checkbox state is still true from
 * before the user switched away from an eligible combination (the checkbox
 * is conditionally rendered, so its state can go stale).
 */
export const buildTransactionPayload = ({
  values,
  categoryId,
  type,
  canBePayment,
  isPayment,
  isTransfer,
  canBeReimbursable,
  isReimbursable,
  reimbursementExpectedAmount,
  canBeSpread = false,
  isSpread = false,
  spreadStartMonth = '',
  spreadMonths = '',
}: {
  values: TransactionFormValues;
  categoryId: string;
  type: string;
  canBePayment: boolean;
  isPayment: boolean;
  isTransfer: boolean;
  canBeReimbursable: boolean;
  isReimbursable: boolean;
  reimbursementExpectedAmount: string;
  canBeSpread?: boolean;
  isSpread?: boolean;
  /** `<input type="month">` value */
  spreadStartMonth?: string;
  spreadMonths?: string;
}): TransactionPayload => {
  const resultingReimbursable = canBeReimbursable && isReimbursable;
  // same stale-state rule as isPayment/isReimbursable: a spread only goes out
  // while the combination can take it
  const resultingSpread = canBeSpread && isSpread && !resultingReimbursable;
  const start = resultingSpread ? monthInputToYyyymm(spreadStartMonth) : null;
  const months = resultingSpread && spreadMonths !== '' ? Number(spreadMonths) : null;
  return {
    accountId: values.accountId,
    categoryId: categoryId || null,
    amount: values.amount,
    type,
    date: values.date,
    payee: values.payee || undefined,
    note: values.note || undefined,
    isPayment: canBePayment && isPayment,
    isTransfer,
    isReimbursable: resultingReimbursable,
    reimbursementExpectedAmount: resultingReimbursable
      ? reimbursementExpectedAmount || undefined
      : undefined,
    spreadStartMonth: start,
    spreadMonths: months,
  };
};
