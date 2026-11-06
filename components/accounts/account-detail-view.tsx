'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Trash2 } from 'lucide-react';
import { BalanceChange } from '@/components/accounts/balance-change';
import { BalanceLineChart } from '@/components/accounts/balance-line-chart';
import { BalanceUpdateForm } from '@/components/accounts/balance-update-form';
import { HistoryRangePills } from '@/components/accounts/history-range-pills';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { accountTypeLabel, isLiabilityAccountType } from '@/lib/account-types';
import { deleteJSON } from '@/lib/api-client';
import { cn } from '@/lib/cn';
import { formatDate } from '@/lib/format';
import type { AccountHistory } from '@/lib/services/accountBalances';
import type { FrontendAccount } from '@/lib/services/accounts';

const money = (value: number): string =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Math.abs(value));

export const AccountDetailView = ({
  account,
  history,
}: {
  account: FrontendAccount;
  history: AccountHistory;
}): React.ReactElement => {
  const router = useRouter();
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deletePending, setDeletePending] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const balance = Number(account.balance);
  const isLiability = isLiabilityAccountType(account.type);

  const handleDelete = async (updateId: string): Promise<void> => {
    setDeletePending(true);
    setDeleteError(null);
    const res = await deleteJSON(`/api/accounts/${account.id}/balance-updates/${updateId}`);
    setDeletePending(false);
    setConfirmDeleteId(null);
    if (!res.ok) {
      setDeleteError('Could not delete that balance update. Try again.');
      return;
    }
    router.refresh();
  };

  return (
    <div className="mt-6.5 flex flex-col gap-4">
      <Link
        href="/accounts"
        className="text-ink-muted hover:text-ink inline-flex w-fit items-center gap-1.5 text-[13px]"
      >
        <ArrowLeft size={14} />
        All accounts
      </Link>

      <section
        aria-label="Balance history"
        className="border-line bg-paper-raised rounded-2xl border p-5.5"
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="text-ink-muted text-[12.5px]">{accountTypeLabel(account.type)}</div>
            <div className="mt-1 flex items-baseline gap-2">
              <span
                className={cn(
                  'font-mono text-[28px] font-medium tracking-[-0.02em] tabular-nums',
                  !isLiability && balance < 0 && 'text-rose',
                )}
              >
                {!isLiability && balance < 0 ? '−' : ''}
                {money(balance)}
              </span>
              {isLiability && balance < 0 && (
                <span className="text-ink-muted text-[12.5px]">owing</span>
              )}
            </div>
            <BalanceChange
              change={history.change}
              rangeLabel={`the last ${history.range} months`}
            />
            {account.balanceUpdatedAt && (
              <p className="text-ink-muted mt-0.5 text-[12.5px]">
                Updated {formatDate(account.balanceUpdatedAt)}
              </p>
            )}
          </div>
          <HistoryRangePills basePath={`/accounts/${account.id}`} range={history.range} />
        </div>
        <div className="mt-4">
          <BalanceLineChart
            points={history.points}
            label={`${account.name} balance at the end of each month`}
          />
        </div>
        {!account.tracksBalance && (
          <p className="text-ink-muted mt-3 text-[12.5px]">
            Month-end balances from your starting balance and transactions.{' '}
            <Link
              href={`/transactions?accountIds=${account.id}`}
              className="text-iris font-medium hover:underline"
            >
              View transactions
            </Link>
          </p>
        )}
      </section>

      {account.tracksBalance && (
        <>
          <section
            aria-label="Log a balance"
            className="border-line bg-paper-raised rounded-2xl border p-5.5"
          >
            <h2 className="font-display mb-3 text-[17px] font-semibold">Log a balance</h2>
            <BalanceUpdateForm
              accountId={account.id}
              accountType={account.type}
              currentBalance={account.balance}
            />
          </section>

          <section
            aria-label="Balance updates"
            className="border-line bg-paper-raised rounded-2xl border p-5.5"
          >
            <h2 className="font-display mb-3 text-[17px] font-semibold">Balance updates</h2>
            {deleteError && (
              <p className="bg-rose-soft text-rose mb-3 rounded-lg px-3 py-2 text-sm" role="alert">
                {deleteError}
              </p>
            )}
            {history.updates.length === 0 ? (
              <p className="text-ink-muted text-sm">
                No balance updates yet. The balance is the starting balance until you log one.
              </p>
            ) : (
              <ul className="divide-line divide-y">
                {history.updates.map((update) => (
                  <li key={update.id} className="flex items-center gap-3 py-2.5">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline gap-2">
                        <span className="font-mono text-[14px] tabular-nums">
                          {Number(update.balance) < 0 ? '−' : ''}
                          {money(Number(update.balance))}
                        </span>
                        {update.change !== null && Number(update.change) !== 0 && (
                          <span
                            className={cn(
                              'font-mono text-[12px] tabular-nums',
                              Number(update.change) > 0 ? 'text-sky' : 'text-rose',
                            )}
                          >
                            {Number(update.change) > 0 ? '+' : '−'}
                            {money(Number(update.change))}
                          </span>
                        )}
                      </div>
                      <div className="text-ink-muted truncate text-[12px]">
                        {formatDate(update.date)}
                        {update.note ? ` · ${update.note}` : ''}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => setConfirmDeleteId(update.id)}
                      aria-label={`Delete balance update from ${formatDate(update.date)}`}
                      className="text-ink-muted hover:text-rose p-2"
                    >
                      <Trash2 size={14} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}

      <ConfirmDialog
        open={confirmDeleteId !== null}
        title="Delete balance update"
        description="Remove this balance from the account's history? This can't be undone."
        pending={deletePending}
        onConfirm={() => confirmDeleteId && handleDelete(confirmDeleteId)}
        onCancel={() => setConfirmDeleteId(null)}
      />
    </div>
  );
};
