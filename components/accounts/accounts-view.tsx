'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ChartLine, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { Modal } from '@/components/ui/modal';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { AccountForm } from '@/components/accounts/account-form';
import { BalanceChange } from '@/components/accounts/balance-change';
import { BalanceLineChart } from '@/components/accounts/balance-line-chart';
import { BalanceUpdateForm } from '@/components/accounts/balance-update-form';
import { HistoryRangePills } from '@/components/accounts/history-range-pills';
import { ReimbursementSummaryCard } from '@/components/accounts/reimbursement-summary-card';
import { deleteJSON } from '@/lib/api-client';
import {
  ACCOUNT_TYPE_GROUPS,
  accountTypeGroup,
  accountTypeLabel,
  isLiabilityAccountType,
} from '@/lib/account-types';
import { formatDate, ordinal } from '@/lib/format';
import { cn } from '@/lib/cn';
import type { NetWorthHistory } from '@/lib/services/accountBalances';
import type { FrontendAccount } from '@/lib/services/accounts';
import type { FrontendReimbursementPendingSummary } from '@/lib/services/reimbursements';

const money = (value: number): string =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Math.abs(value));

export const AccountsView = ({
  initialAccounts,
  pendingReimbursement,
  netWorthHistory,
  zeroBased = false,
}: {
  initialAccounts: FrontendAccount[];
  pendingReimbursement: FrontendReimbursementPendingSummary;
  netWorthHistory: NetWorthHistory;
  zeroBased?: boolean;
}): React.ReactElement => {
  const router = useRouter();
  const [dialogKey, setDialogKey] = useState(0);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<FrontendAccount | undefined>(undefined);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deletePending, setDeletePending] = useState(false);
  const [loggingFor, setLoggingFor] = useState<FrontendAccount | null>(null);

  const openCreate = (): void => {
    setEditing(undefined);
    setDialogKey((k) => k + 1);
    setOpen(true);
  };

  const openEdit = (account: FrontendAccount): void => {
    setEditing(account);
    setDialogKey((k) => k + 1);
    setOpen(true);
  };

  const handleDelete = async (id: string): Promise<void> => {
    setDeletePending(true);
    await deleteJSON(`/api/accounts/${id}`);
    setDeletePending(false);
    setConfirmDeleteId(null);
    router.refresh();
  };

  const netWorth = initialAccounts.reduce((sum, a) => sum + Number(a.balance), 0);
  const totalTransactions = initialAccounts.reduce((sum, a) => sum + a.transactionCount, 0);
  const lastImportAt = initialAccounts.reduce<string | null>(
    (latest, a) =>
      a.lastImportAt && (!latest || a.lastImportAt > latest) ? a.lastImportAt : latest,
    null,
  );

  const renderAccountCard = (account: FrontendAccount, index: number): React.ReactElement => {
    const balance = Number(account.balance);
    const isCreditCard = account.type === 'CREDIT_CARD';
    const isLiability = isLiabilityAccountType(account.type);
    const owing = isLiability && balance < 0;
    const noStartingBalance = Number(account.startingBalance) === 0 && balance < 0;
    return (
      <div
        key={account.id}
        style={{ '--i': index } as React.CSSProperties}
        className={cn(
          'stagger-item bg-paper-raised rounded-2xl border p-5.5',
          noStartingBalance ? 'border-iris/35' : 'border-line',
        )}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <Link
              href={`/accounts/${account.id}`}
              className="font-display text-[17px] font-semibold hover:underline"
            >
              {account.name}
            </Link>
            <div className="text-ink-muted mt-0.5 text-[12.5px]">
              {accountTypeLabel(account.type)}
            </div>
          </div>
        </div>
        <div className="mt-2.5 flex items-baseline gap-2">
          <span
            className={cn(
              'font-mono text-[26px] font-medium tracking-[-0.02em] tabular-nums',
              !isLiability && balance < 0 && 'text-rose',
            )}
          >
            {!isLiability && balance < 0 ? '−' : ''}
            {money(balance)}
          </span>
          {owing && <span className="text-ink-muted text-[12.5px]">owing</span>}
        </div>

        {noStartingBalance && (
          <div className="bg-iris-soft mt-3 flex items-start gap-2.5 rounded-xl px-3.5 py-3">
            <span className="bg-iris text-paper-raised mt-0.5 flex size-4.5 shrink-0 items-center justify-center rounded-full text-[12px] font-semibold">
              !
            </span>
            <div className="min-w-0">
              <p className="text-ink-muted text-[12.5px] leading-snug">
                This is negative because no starting balance was set — it&rsquo;s the sum of
                transactions only.
              </p>
              <button
                type="button"
                onClick={() => openEdit(account)}
                className="bg-iris text-paper-raised mt-2 rounded-full px-3.5 py-2 text-[12.5px] font-semibold"
              >
                Set starting balance
              </button>
            </div>
          </div>
        )}

        <div className="text-ink-muted mt-3 text-[11.5px]">
          {zeroBased && !account.onBudget ? 'Off-budget · ' : ''}
          {account.tracksBalance ? (
            account.balanceUpdatedAt ? (
              `Balance updated ${formatDate(account.balanceUpdatedAt)}`
            ) : (
              'No balance updates yet'
            )
          ) : (
            <>
              {isCreditCard && account.statementDay
                ? `Statement closes the ${ordinal(account.statementDay)} · `
                : ''}
              {account.transactionCount} transaction{account.transactionCount === 1 ? '' : 's'}
              {!isCreditCard &&
                (account.lastImportAt ? ` · last import ${formatDate(account.lastImportAt)}` : '')}
            </>
          )}
        </div>

        <div className="border-line mt-4.5 flex flex-wrap gap-2 border-t pt-4">
          {account.tracksBalance && (
            <button
              type="button"
              onClick={() => setLoggingFor(account)}
              className="bg-iris text-paper-raised inline-flex items-center gap-1.5 rounded-full px-3.5 py-2 text-[13px] font-medium"
            >
              <RefreshCw size={13} />
              Log balance
            </button>
          )}
          <Link
            href={`/accounts/${account.id}`}
            className="border-line text-ink inline-flex items-center gap-1.5 rounded-full border px-3.5 py-2 text-[13px]"
          >
            <ChartLine size={13} />
            History
          </Link>
          <button
            type="button"
            onClick={() => openEdit(account)}
            className="border-line text-ink inline-flex items-center gap-1.5 rounded-full border px-3.5 py-2 text-[13px]"
          >
            <Pencil size={13} />
            Edit
          </button>
          <button
            type="button"
            onClick={() => setConfirmDeleteId(account.id)}
            className="text-ink-muted hover:text-rose inline-flex items-center gap-1.5 px-1 py-2 text-[13px]"
          >
            <Trash2 size={13} />
            Delete
          </button>
        </div>
      </div>
    );
  };

  // startIndex keeps the stagger animation continuous across groups
  const groups: { group: string; accounts: FrontendAccount[]; startIndex: number }[] = [];
  let startIndex = 0;
  for (const group of ACCOUNT_TYPE_GROUPS) {
    const accounts = initialAccounts.filter((a) => accountTypeGroup(a.type) === group);
    if (accounts.length === 0) continue;
    groups.push({ group, accounts, startIndex });
    startIndex += accounts.length;
  }

  return (
    <div className="mt-6.5">
      <ReimbursementSummaryCard summary={pendingReimbursement} />
      {initialAccounts.length === 0 && (
        <p className="text-ink-muted mb-4 text-sm">
          No accounts yet. Add one to start logging transactions.
        </p>
      )}

      {initialAccounts.length > 0 && (
        <div className="border-line bg-paper-raised mb-4 rounded-2xl border p-5.5">
          <div className="text-ink-muted text-[11px] tracking-[0.08em] uppercase">
            Net across {initialAccounts.length} account{initialAccounts.length === 1 ? '' : 's'}
          </div>
          <div
            className={cn(
              'mt-1.5 font-mono text-[28px] font-medium tracking-[-0.02em] tabular-nums',
              netWorth < 0 ? 'text-rose' : 'text-ink',
            )}
          >
            {netWorth < 0 ? '−' : ''}
            {money(netWorth)}
          </div>
          <div className="text-ink-muted mt-1.5 text-[12.5px]">
            {lastImportAt ? `As of your ${formatDate(lastImportAt)} import · ` : ''}
            {totalTransactions} transaction{totalTransactions === 1 ? '' : 's'}
          </div>
          <section aria-label="Net worth over time" className="border-line mt-4 border-t pt-4">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <BalanceChange
                change={netWorthHistory.change}
                rangeLabel={`the last ${netWorthHistory.range} months`}
              />
              <HistoryRangePills basePath="/accounts" range={netWorthHistory.range} />
            </div>
            <BalanceLineChart
              points={netWorthHistory.points}
              label="Net worth at the end of each month"
            />
          </section>
        </div>
      )}

      {groups.map(({ group, accounts, startIndex }) => (
        <section key={group} aria-label={group} className="mb-6">
          <h2 className="text-ink-muted mb-2.5 text-[11px] tracking-[0.08em] uppercase">{group}</h2>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {accounts.map((account, i) => renderAccountCard(account, startIndex + i))}
          </div>
        </section>
      ))}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <button
          type="button"
          onClick={openCreate}
          className="border-ink-muted/40 hover:border-iris hover:text-iris focus-visible:outline-iris text-ink-muted flex min-h-[190px] cursor-pointer flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2"
        >
          <Plus size={22} />
          <span className="text-sm font-medium">Add an account</span>
        </button>
      </div>

      <Modal
        key={dialogKey}
        open={open}
        onClose={() => setOpen(false)}
        title={editing ? 'Edit account' : 'Add account'}
      >
        <AccountForm account={editing} onDone={() => setOpen(false)} zeroBased={zeroBased} />
      </Modal>
      <Modal
        open={loggingFor !== null}
        onClose={() => setLoggingFor(null)}
        title={loggingFor ? `Log balance · ${loggingFor.name}` : 'Log balance'}
      >
        {loggingFor && (
          <BalanceUpdateForm
            accountId={loggingFor.id}
            currentBalance={loggingFor.balance}
            onDone={() => setLoggingFor(null)}
          />
        )}
      </Modal>
      <ConfirmDialog
        open={confirmDeleteId !== null}
        title="Delete account"
        description="Delete this account and all its transactions? This can't be undone."
        pending={deletePending}
        onConfirm={() => confirmDeleteId && handleDelete(confirmDeleteId)}
        onCancel={() => setConfirmDeleteId(null)}
      />
    </div>
  );
};
