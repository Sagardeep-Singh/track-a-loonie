'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  buildTransactionPayload,
  yyyymmToMonthInput,
  type TransactionFormValues,
} from '@/lib/transactions/transaction-payload';
import { isLiabilityAccountType } from '@/lib/account-types';
import type { FrontendAccount } from '@/lib/services/accounts';
import type { FrontendTransaction } from '@/lib/services/transactions';

export type { TransactionFormValues };

export type TransactionFormHook = {
  categoryId: string;
  setCategoryId: (id: string) => void;
  suggested: boolean;
  setSuggested: (value: boolean) => void;
  type: string;
  setType: (type: string) => void;
  accountId: string;
  setAccountId: (id: string) => void;
  isPayment: boolean;
  setIsPayment: (value: boolean) => void;
  isTransfer: boolean;
  setIsTransfer: (value: boolean) => void;
  canBePayment: boolean;
  isReimbursable: boolean;
  setIsReimbursable: (value: boolean) => void;
  reimbursementExpectedAmount: string;
  setReimbursementExpectedAmount: (value: string) => void;
  canBeReimbursable: boolean;
  isSpread: boolean;
  setIsSpread: (value: boolean) => void;
  /** `<input type="month">` value, e.g. "2026-01" */
  spreadStartMonth: string;
  setSpreadStartMonth: (value: string) => void;
  spreadMonths: string;
  setSpreadMonths: (value: string) => void;
  canBeSpread: boolean;
  pending: boolean;
  error: string | null;
  suggestFor: (payee: string, note: string) => void;
  submit: (values: TransactionFormValues) => Promise<boolean>;
};

/**
 * The state and submit logic behind both transaction entry surfaces: the
 * desktop `TransactionForm` and the mobile keypad screen.
 *
 * Deliberately not given a `FormEvent`: the desktop form reads its
 * amount/payee/date/note off `FormData` (uncontrolled inputs), while the
 * mobile keypad drives the amount as plain React state. `submit` takes the
 * already-collected values so both can share everything else.
 *
 * Takes neither `categories` nor `onDone`: the category list is only ever
 * rendered (by each surface's own chip markup), and `onDone` is invoked by
 * the caller — `submit` only reports success so each surface can decide
 * what to do next.
 */
export const useTransactionForm = ({
  transaction,
  accounts,
}: {
  transaction?: FrontendTransaction;
  accounts: FrontendAccount[];
}): TransactionFormHook => {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [categoryId, setCategoryId] = useState(transaction?.categoryId ?? '');
  const [suggested, setSuggested] = useState(false);
  const [type, setType] = useState<string>(transaction?.type ?? 'EXPENSE');
  const [accountId, setAccountId] = useState(transaction?.accountId ?? accounts[0]?.id ?? '');
  const [isPayment, setIsPayment] = useState(transaction?.isPayment ?? false);
  const [isTransfer, setIsTransfer] = useState(transaction?.isTransfer ?? false);
  const [isReimbursable, setIsReimbursable] = useState(transaction?.isReimbursable ?? false);
  const [reimbursementExpectedAmount, setReimbursementExpectedAmount] = useState(
    transaction?.reimbursementExpectedAmount ?? '',
  );
  const [isSpread, setIsSpread] = useState(transaction?.spreadMonths != null);
  const [spreadStartMonth, setSpreadStartMonth] = useState(
    transaction?.spreadStartMonth != null ? yyyymmToMonthInput(transaction.spreadStartMonth) : '',
  );
  const [spreadMonths, setSpreadMonths] = useState(
    transaction?.spreadMonths != null ? String(transaction.spreadMonths) : '12',
  );

  const selectedAccount = accounts.find((a) => a.id === accountId);
  const canBePayment = type === 'INCOME' && isLiabilityAccountType(selectedAccount?.type);
  const canBeReimbursable = type === 'EXPENSE' && !isTransfer && !isPayment;
  // reimbursable and spread are mutually exclusive; each surface disables one
  // while the other is on
  const canBeSpread = canBeReimbursable;
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const suggestFor = (payee: string, note: string): void => {
    if (transaction || categoryId) return; // don't override an explicit choice or existing edit
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      const text = `${payee} ${note}`.trim();
      if (!text) return;
      const res = await fetch('/api/categorize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) return;
      const data = await res.json();
      if (data.categoryId) {
        setCategoryId(data.categoryId);
        setSuggested(true);
      }
    }, 400);
  };

  useEffect(
    () => () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    },
    [],
  );

  const submit = async (values: TransactionFormValues): Promise<boolean> => {
    setPending(true);
    setError(null);

    const body = buildTransactionPayload({
      values,
      categoryId,
      type,
      canBePayment,
      isPayment,
      isTransfer,
      canBeReimbursable,
      isReimbursable,
      reimbursementExpectedAmount,
      canBeSpread,
      isSpread,
      spreadStartMonth,
      spreadMonths,
    });

    const res = await fetch(
      transaction ? `/api/transactions/${transaction.id}` : '/api/transactions',
      {
        method: transaction ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
    );

    setPending(false);
    if (!res.ok) {
      setError('Could not save this transaction. Check the fields and try again.');
      return false;
    }

    router.refresh();
    return true;
  };

  return {
    categoryId,
    setCategoryId,
    suggested,
    setSuggested,
    type,
    setType,
    accountId,
    setAccountId,
    isPayment,
    setIsPayment,
    isTransfer,
    setIsTransfer,
    canBePayment,
    isReimbursable,
    setIsReimbursable,
    reimbursementExpectedAmount,
    setReimbursementExpectedAmount,
    canBeReimbursable,
    isSpread,
    setIsSpread,
    spreadStartMonth,
    setSpreadStartMonth,
    spreadMonths,
    setSpreadMonths,
    canBeSpread,
    pending,
    error,
    suggestFor,
    submit,
  };
};
