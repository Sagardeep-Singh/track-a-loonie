'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { HandCoins, Loader2 } from 'lucide-react';
import { Money } from '@/components/ui/money';
import { formatDate } from '@/lib/format';
import { getJSON } from '@/lib/api-client';
import { transactionDetailHref } from '@/lib/transactions/transaction-filters';
import type { FrontendReimbursedExpense } from '@/lib/services/reimbursements';

/** On an income linked as a reimbursement: the expenses it pays back, each linking to that expense. */
export const ReimbursedExpensesList = ({
  incomeTransactionId,
}: {
  incomeTransactionId: string;
}): React.ReactElement => {
  const [expenses, setExpenses] = useState<FrontendReimbursedExpense[] | null>(null);
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    void getJSON<FrontendReimbursedExpense[]>(
      `/api/transactions/${incomeTransactionId}/reimbursed-expenses`,
      { signal: controller.signal },
    ).then((res) => {
      if (controller.signal.aborted) return;
      if (res.ok) setExpenses(res.data);
      else setLoadError(true);
    });
    return () => controller.abort();
  }, [incomeTransactionId]);

  return (
    <div className="border-line bg-paper-sunk mt-3 rounded-[14px] border p-4">
      <span className="text-ink-muted flex items-center gap-1.5 text-[11px] font-semibold tracking-[0.1em] uppercase">
        <HandCoins size={12} />
        Reimburses
      </span>
      {loadError ? (
        <p className="text-rose mt-2 text-sm" role="alert">
          Couldn&apos;t load the expenses this income reimburses.
        </p>
      ) : expenses === null ? (
        <div className="mt-2 flex items-center gap-2">
          <Loader2 size={14} className="animate-spin" />
          <span className="text-ink-muted text-sm" role="status">
            Loading…
          </span>
        </div>
      ) : (
        <ul className="divide-line mt-1 divide-y">
          {expenses.map((e) => (
            <li key={e.linkId}>
              <Link
                href={transactionDetailHref(e.expenseDate, e.expenseTransactionId)}
                className="group flex items-center gap-3 py-2.5"
              >
                <div className="min-w-0 flex-1">
                  <div className="text-iris truncate text-sm font-medium group-hover:underline">
                    {e.expensePayee || 'Expense'}
                  </div>
                  <div className="text-ink-muted text-xs">
                    {formatDate(e.expenseDate)} · {e.expenseAccountName} ·{' '}
                    <Money value={e.expenseAmount} tone="neutral" className="text-xs" />
                  </div>
                </div>
                <Money value={e.amount} tone="income" />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};
