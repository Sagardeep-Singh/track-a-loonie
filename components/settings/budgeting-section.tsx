'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { pillOption } from '@/components/settings/pills';
import { PillGroup, PillHighlight } from '@/components/settings/pill-group';
import { Button } from '@/components/ui/button';
import { writeBudgetModeCookie } from '@/lib/budget-mode-cookie';
import { patchJSON } from '@/lib/api-client';
import type { FrontendAccount } from '@/lib/services/accounts';
import type { BudgetMode, FrontendBudgetSettings } from '@/lib/services/zeroBased';

const MODE_LABELS: Record<BudgetMode, string> = {
  LIMITS: 'Spending limits',
  ZERO_BASED: 'Zero-based',
};

const REIMBURSEMENT_OPTIONS = [
  { inExpenseMonth: false, label: 'When received' },
  { inExpenseMonth: true, label: 'Expense month' },
];

/**
 * Budgeting style picker. Turning zero-based on goes through a confirm step
 * that lists accounts with on-budget toggles, since which accounts feed Ready
 * to Assign is the one choice that shapes every number on the new screen.
 * Switching back is a single click: nothing is deleted either way.
 */
export const BudgetingSection = ({
  settings,
  accounts,
}: {
  settings: FrontendBudgetSettings;
  accounts: FrontendAccount[];
}): React.ReactElement => {
  const router = useRouter();
  const [mode, setMode] = useState(settings.mode);
  const [confirming, setConfirming] = useState(false);
  const [onBudget, setOnBudget] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(accounts.map((a) => [a.id, a.onBudget])),
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inExpenseMonth, setInExpenseMonth] = useState(settings.reimbursementsInExpenseMonth);

  const pickReimbursementMonth = async (next: boolean): Promise<void> => {
    if (next === inExpenseMonth || pending) return;
    setError(null);
    setPending(true);
    const res = await patchJSON<FrontendBudgetSettings>('/api/settings/reimbursement-attribution', {
      reimbursementsInExpenseMonth: next,
    });
    setPending(false);
    if (!res.ok) {
      setError(res.error ?? 'Could not change when reimbursements count.');
      return;
    }
    setInExpenseMonth(res.data.reimbursementsInExpenseMonth);
    router.refresh();
  };

  const saveMode = async (next: BudgetMode): Promise<boolean> => {
    const res = await patchJSON<FrontendBudgetSettings>('/api/settings/budget-mode', {
      mode: next,
    });
    if (!res.ok) {
      setError(res.error ?? 'Could not change the budgeting style.');
      return false;
    }
    setMode(res.data.mode);
    writeBudgetModeCookie(res.data.mode);
    router.refresh();
    return true;
  };

  const pick = async (next: BudgetMode): Promise<void> => {
    if (next === mode || pending) return;
    setError(null);
    if (next === 'ZERO_BASED') {
      setConfirming(true);
      return;
    }
    setPending(true);
    await saveMode(next);
    setPending(false);
  };

  const enable = async (): Promise<void> => {
    setPending(true);
    setError(null);
    const changed = accounts.filter((a) => onBudget[a.id] !== a.onBudget);
    const results = await Promise.all(
      changed.map((a) => patchJSON(`/api/accounts/${a.id}`, { onBudget: onBudget[a.id] })),
    );
    if (results.some((r) => !r.ok)) {
      setPending(false);
      setError('Could not save which accounts are on-budget.');
      return;
    }
    if (await saveMode('ZERO_BASED')) setConfirming(false);
    setPending(false);
  };

  return (
    <div className="border-line bg-paper-raised rounded-2xl border p-5">
      <h2 className="font-display text-[15px] font-semibold">Budgeting</h2>
      <div className="flex items-center gap-5 py-3.5">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium">Style</div>
          <div className="text-ink-muted mt-0.5 text-[12.5px]">
            {mode === 'ZERO_BASED'
              ? 'Assign every dollar you have to a category. Switching back keeps your assignments.'
              : 'A monthly limit per category. Switching keeps your limits.'}
          </div>
        </div>
        <PillGroup>
          {(Object.keys(MODE_LABELS) as BudgetMode[]).map((m) => (
            <button
              key={m}
              type="button"
              aria-pressed={(confirming ? 'ZERO_BASED' : mode) === m}
              onClick={() => pick(m)}
              disabled={pending}
              className={pillOption((confirming ? 'ZERO_BASED' : mode) === m, pending)}
            >
              <PillHighlight active={(confirming ? 'ZERO_BASED' : mode) === m} />
              <span className="relative">{MODE_LABELS[m]}</span>
            </button>
          ))}
        </PillGroup>
      </div>

      <div className="border-line flex items-center gap-5 border-t py-3.5">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium">Reimbursements</div>
          <div className="text-ink-muted mt-0.5 text-[12.5px]">
            {inExpenseMonth
              ? 'Taken off the expense they pay back, in that month. Past months can change.'
              : 'Count as income when the money arrives. Expenses stay in full in the month you spent.'}
          </div>
        </div>
        <PillGroup>
          {REIMBURSEMENT_OPTIONS.map((o) => (
            <button
              key={o.label}
              type="button"
              aria-pressed={inExpenseMonth === o.inExpenseMonth}
              onClick={() => pickReimbursementMonth(o.inExpenseMonth)}
              disabled={pending}
              className={pillOption(inExpenseMonth === o.inExpenseMonth, pending)}
            >
              <PillHighlight active={inExpenseMonth === o.inExpenseMonth} />
              <span className="relative">{o.label}</span>
            </button>
          ))}
        </PillGroup>
      </div>

      {confirming && (
        <div className="border-line bg-paper mt-1 rounded-xl border p-4">
          <p className="text-[13.5px] leading-snug">
            Pick the accounts whose money you want to budget. Their balances become Ready to Assign,
            and you give every dollar a job. Off-budget accounts, like long-term savings, are still
            tracked everywhere else.
          </p>
          {accounts.length === 0 ? (
            <p className="text-ink-muted mt-3 text-[12.5px]">
              You don&rsquo;t have any accounts yet. Add one to see money to assign.
            </p>
          ) : (
            <ul className="mt-3 flex flex-col gap-2">
              {accounts.map((a) => (
                <li key={a.id}>
                  <label className="flex items-center gap-3 text-sm">
                    <input
                      type="checkbox"
                      className="accent-iris size-4"
                      checked={onBudget[a.id] ?? false}
                      onChange={(e) =>
                        setOnBudget((prev) => ({ ...prev, [a.id]: e.target.checked }))
                      }
                    />
                    <span className="min-w-0 flex-1 truncate">{a.name}</span>
                    <span className="text-ink-muted font-mono text-[12.5px] tabular-nums">
                      ${a.balance}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          )}
          <div className="mt-4 flex gap-2.5">
            <Button
              type="button"
              variant="secondary"
              onClick={() => setConfirming(false)}
              disabled={pending}
            >
              Cancel
            </Button>
            <Button type="button" loading={pending} onClick={enable}>
              Turn on zero-based
            </Button>
          </div>
        </div>
      )}

      {error && (
        <p className="text-rose mt-2 text-sm" role="alert">
          {error}
        </p>
      )}
    </div>
  );
};
