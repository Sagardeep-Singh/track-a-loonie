'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { m } from 'framer-motion';
import Link from 'next/link';
import { Check, Pencil, Plus, Trash2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/field';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { AnimatedMoney } from '@/components/ui/animated-money';
import { patchJSON, postJSON, deleteJSON } from '@/lib/api-client';
import { cn } from '@/lib/cn';
import { spring } from '@/lib/motion/tokens';
import { useReducedTransition } from '@/lib/motion/use-reduced-transition';
import { daysInMonth } from '@/lib/date';
import { monthToRange } from '@/lib/period-selection';
import { transactionsHref } from '@/lib/transactions/transaction-filters';
import type { FrontendBudget } from '@/lib/services/budgets';
import type { FrontendCategory } from '@/lib/services/categories';
import type { UncategorizedMonthSummary } from '@/lib/services/categorize';

const MONTH_LABEL = new Intl.DateTimeFormat('en-US', {
  timeZone: 'UTC',
  month: 'short',
  year: 'numeric',
});

const monthLabel = (month: number): string =>
  MONTH_LABEL.format(new Date(Date.UTC(Math.floor(month / 100), (month % 100) - 1, 1)));

const MONTH_ONLY = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'long' });
const monthOnly = (month: number): string =>
  MONTH_ONLY.format(new Date(Date.UTC(Math.floor(month / 100), (month % 100) - 1, 1)));

const paceText = (limit: number, spent: number, month: number): string => {
  const now = new Date();
  const currentMonth = now.getUTCFullYear() * 100 + (now.getUTCMonth() + 1);
  const total = daysInMonth(month);
  const elapsed = month === currentMonth ? now.getUTCDate() : month > currentMonth ? 0 : total;
  const remaining = Math.max(total - elapsed, 0);
  if (remaining === 0) return spent > limit ? 'Over for the month' : 'On track for the month';
  const perDay = Math.max(limit - spent, 0) / remaining;
  return spent > limit
    ? `${remaining} ${remaining === 1 ? 'day' : 'days'} left, already over`
    : `$${perDay.toFixed(2)}/day left to stay on track`;
};

/**
 * Budgets-only ring: three-tier color (sky under pace, iris near the limit,
 * rose over) instead of the shared `Ring`'s two-tone alertAt threshold, and
 * a second inner ring showing the overage fraction once a budget is blown
 * past 100% — neither exists in `components/ui/ring.tsx`, which stays
 * untouched since Overview/other screens rely on its current behavior.
 */
const BudgetRing = ({ fraction }: { fraction: number }): React.ReactElement => {
  const over = fraction > 1;
  const near = fraction >= 0.85;
  const color = over ? 'var(--rose)' : near ? 'var(--iris)' : 'var(--sky)';
  const outerR = 36;
  const outerStroke = 8;
  const outerC = 2 * Math.PI * outerR;
  const innerR = 25;
  const innerStroke = 4.5;
  const innerC = 2 * Math.PI * innerR;
  const excess = Math.min(Math.max(fraction - 1, 0), 1);
  // Outer ring fills first; the overage ring follows once it's full.
  const fillTransition = useReducedTransition(spring.smooth);
  const overageTransition = useReducedTransition({ ...spring.smooth, delay: 0.35 });

  return (
    <div className="size-[84px] shrink-0">
      <svg width="84" height="84" viewBox="0 0 84 84">
        <circle
          cx="42"
          cy="42"
          r={outerR}
          fill="none"
          stroke="var(--paper-sunk)"
          strokeWidth={outerStroke}
        />
        <m.circle
          cx="42"
          cy="42"
          r={outerR}
          fill="none"
          stroke={color}
          strokeWidth={outerStroke}
          strokeLinecap={over ? undefined : 'round'}
          initial={{ strokeDasharray: `0 ${outerC}` }}
          animate={{ strokeDasharray: `${outerC * Math.min(fraction, 1)} ${outerC}` }}
          transition={fillTransition}
          transform="rotate(-90 42 42)"
        />
        {over && (
          <>
            <circle
              cx="42"
              cy="42"
              r={innerR}
              fill="none"
              stroke="var(--rose-soft)"
              strokeWidth={innerStroke}
            />
            <m.circle
              cx="42"
              cy="42"
              r={innerR}
              fill="none"
              stroke="var(--rose)"
              strokeWidth={innerStroke}
              strokeLinecap="round"
              initial={{ strokeDasharray: `0 ${innerC}` }}
              animate={{ strokeDasharray: `${innerC * excess} ${innerC}` }}
              transition={overageTransition}
              transform="rotate(-90 42 42)"
            />
          </>
        )}
        <line x1="42" y1="1.4" x2="42" y2="10.6" stroke="var(--paper-raised)" strokeWidth="2.6" />
      </svg>
    </div>
  );
};

export const BudgetsView = ({
  initialBudgets,
  categories,
  month,
  uncategorized,
}: {
  initialBudgets: FrontendBudget[];
  categories: FrontendCategory[];
  month: number;
  uncategorized: UncategorizedMonthSummary;
}): React.ReactElement => {
  const router = useRouter();
  const budgetedCategoryIds = new Set(initialBudgets.map((b) => b.categoryId));
  const available = categories.filter((c) => !budgetedCategoryIds.has(c.id));

  const [showAddForm, setShowAddForm] = useState(false);
  const [categoryId, setCategoryId] = useState(available[0]?.id ?? '');
  // `available` is derived from props that change on month navigation, but
  // `categoryId` is only initialized once — fall back when it no longer
  // points at an available category instead of trusting the stale value.
  const selectedCategoryId = available.some((c) => c.id === categoryId)
    ? categoryId
    : (available[0]?.id ?? '');
  const [limitAmount, setLimitAmount] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deletePending, setDeletePending] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [editPending, setEditPending] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  const startEdit = (budget: FrontendBudget): void => {
    setEditingId(budget.id);
    setEditValue(budget.limitAmount);
    setEditError(null);
  };

  const cancelEdit = (): void => {
    setEditingId(null);
    setEditError(null);
  };

  const handleEditSave = async (budget: FrontendBudget): Promise<void> => {
    setEditPending(true);
    setEditError(null);
    // A budget carried forward from an earlier month has a different id/month
    // than the one being viewed — editing it starts a new value from this
    // month forward instead of rewriting history.
    const startsNewMonth = budget.month !== month;
    const res = startsNewMonth
      ? await postJSON('/api/budgets', {
          categoryId: budget.categoryId,
          month,
          limitAmount: editValue,
        })
      : await patchJSON(`/api/budgets/${budget.id}`, { limitAmount: editValue });
    setEditPending(false);
    if (!res.ok) {
      setEditError('Could not update that budget.');
      return;
    }
    setEditingId(null);
    router.refresh();
  };

  const handleAdd = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setPending(true);
    setError(null);
    const res = await postJSON('/api/budgets', {
      categoryId: selectedCategoryId,
      limitAmount,
      month,
    });
    setPending(false);
    if (!res.ok) {
      setError('Could not set that budget. It may already exist for this month.');
      return;
    }
    setLimitAmount('');
    setShowAddForm(false);
    router.refresh();
  };

  const confirmDeletingBudget = initialBudgets.find((b) => b.id === confirmDeleteId) ?? null;

  const handleDelete = async (id: string): Promise<void> => {
    setDeletePending(true);
    await deleteJSON(`/api/budgets/${id}`);
    setDeletePending(false);
    setConfirmDeleteId(null);
    router.refresh();
  };

  const totalLimit = initialBudgets.reduce((sum, b) => sum + Number(b.limitAmount), 0);
  const totalSpent = initialBudgets.reduce((sum, b) => sum + Number(b.spent), 0);
  const totalFraction = totalLimit > 0 ? totalSpent / totalLimit : 0;
  const totalOver = totalSpent > totalLimit;
  const totalNear = totalFraction >= 0.85;
  const totalToneClass = totalOver ? 'text-rose' : totalNear ? 'text-iris' : 'text-sky';
  const totalBarClass = totalOver ? 'bg-rose' : totalNear ? 'bg-iris' : 'bg-sky';

  return (
    <div className="mt-6.5">
      {categories.length === 0 ? (
        <div className="border-line bg-paper-raised flex flex-col items-center gap-3 rounded-2xl border border-dashed p-8 text-center">
          <p className="text-ink-muted text-sm">
            You don&apos;t have any categories yet. Add one to start setting budgets.
          </p>
          <Link
            href="/categories"
            className="bg-iris text-paper-raised focus-visible:outline-iris inline-flex cursor-pointer items-center justify-center gap-2 rounded-full px-4 py-2 text-sm font-medium transition-colors duration-150 hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2"
          >
            <Plus size={16} />
            Add categories
          </Link>
        </div>
      ) : (
        <>
          {initialBudgets.length > 0 && (
            <div className="border-line bg-paper-raised rounded-[18px] border p-5.5">
              <div className="flex items-baseline justify-between gap-2.5">
                <span className="text-ink-muted text-[11px] tracking-[0.08em] uppercase">
                  All {initialBudgets.length} budget{initialBudgets.length === 1 ? '' : 's'} ·{' '}
                  {monthOnly(month)}
                </span>
                <span
                  className={cn(
                    'flex items-center gap-1.5 text-[11px] font-semibold tracking-[0.04em] uppercase',
                    totalToneClass,
                  )}
                >
                  <span className={cn('size-1.5 rounded-full', totalBarClass)} />
                  {totalOver ? 'Over budget' : totalNear ? 'Close call' : 'On track'}
                </span>
              </div>
              <div className={cn('font-display mt-2 text-xl font-semibold', totalToneClass)}>
                {totalOver
                  ? `Over budget by $${(totalSpent - totalLimit).toFixed(2)}`
                  : `Under budget by $${(totalLimit - totalSpent).toFixed(2)}`}
              </div>
              <div className="text-ink-muted mt-1.5 font-mono text-[13px] tabular-nums">
                ${totalSpent.toFixed(2)} of ${totalLimit.toFixed(2)}
              </div>
              <div className="bg-paper-sunk mt-3 flex h-1.75 overflow-hidden rounded-full">
                <span
                  className={cn('block', totalBarClass)}
                  style={{ width: `${Math.round(Math.min(totalFraction, 1) * 100)}%` }}
                />
              </div>
              {uncategorized.count > 0 && (
                <>
                  <div className="bg-line my-3.5 h-px" />
                  <div className="flex items-start gap-2.5">
                    <span className="bg-ink-muted mt-1 size-2.5 shrink-0 rounded-[3px]" />
                    <div className="min-w-0">
                      <p className="text-ink-muted text-[12.5px] leading-snug">
                        {uncategorized.count} uncategorized transaction
                        {uncategorized.count === 1 ? '' : 's'} — ${uncategorized.amount} — count
                        toward none of these budgets, so every number here is understated.
                      </p>
                      <Link
                        href="/categorize"
                        className="border-line text-iris mt-2 inline-flex min-h-10 items-center rounded-full border px-3.5 text-[12.5px] font-semibold"
                      >
                        Categorize them
                      </Link>
                    </div>
                  </div>
                </>
              )}
            </div>
          )}

          {error && <p className="text-rose mt-3 text-sm">{error}</p>}

          {initialBudgets.length > 0 && (
            <div className="mt-4.5 grid grid-cols-1 gap-4 lg:grid-cols-2">
              {initialBudgets.map((budget, index) => {
                const limit = Number(budget.limitAmount);
                const spent = Number(budget.spent);
                const fraction = limit > 0 ? spent / limit : 0;
                const over = spent > limit;
                const near = fraction >= 0.85;
                const toneClass = over ? 'text-rose' : near ? 'text-iris' : 'text-sky';
                return (
                  <div
                    key={budget.id}
                    style={{ '--i': index } as React.CSSProperties}
                    className="stagger-item border-line bg-paper-raised hover:border-iris relative flex items-center gap-5.5 rounded-2xl border p-5.5 transition-colors"
                  >
                    <BudgetRing fraction={fraction} />
                    <div className="min-w-0 flex-1">
                      {/* Stretched link: its ::after covers the whole card, so a
                          click anywhere opens the matching transactions. The
                          edit/remove controls sit above it (relative z-10). Spending
                          + hide transfers mirrors how `spent` is computed. */}
                      <Link
                        href={transactionsHref({
                          ...monthToRange(month),
                          categoryIds: [budget.categoryId],
                          type: 'EXPENSE',
                          hideTransfers: true,
                        })}
                        className="font-display block text-base font-semibold after:absolute after:inset-0 after:rounded-2xl"
                      >
                        {budget.categoryName}
                      </Link>
                      <div className={cn('font-display mt-1 text-lg font-semibold', toneClass)}>
                        {over ? (
                          <>
                            Over by <AnimatedMoney value={spent - limit} />
                          </>
                        ) : (
                          <>
                            <AnimatedMoney value={limit - spent} /> left
                          </>
                        )}
                      </div>
                      <div className="text-ink-muted mt-1 font-mono text-[12.5px] tabular-nums">
                        ${spent.toFixed(2)} of ${limit.toFixed(2)}
                      </div>
                      {editingId === budget.id ? (
                        <div className="relative z-10 mt-2.5">
                          <div className="flex items-center gap-1.5">
                            <Input
                              className="rounded-[9px] font-mono"
                              type="number"
                              step="0.01"
                              autoFocus
                              value={editValue}
                              onChange={(e) => setEditValue(e.target.value)}
                            />
                            <button
                              type="button"
                              onClick={() => handleEditSave(budget)}
                              disabled={editPending}
                              className="text-sky hover:text-ink inline-flex items-center p-1.5 disabled:opacity-50"
                              aria-label="Save budget"
                            >
                              <Check size={16} />
                            </button>
                            <button
                              type="button"
                              onClick={cancelEdit}
                              disabled={editPending}
                              className="text-ink-muted hover:text-ink inline-flex items-center p-1.5 disabled:opacity-50"
                              aria-label="Cancel edit"
                            >
                              <X size={16} />
                            </button>
                          </div>
                          {editError && <p className="text-rose mt-1.5 text-xs">{editError}</p>}
                        </div>
                      ) : (
                        <>
                          <div className="mt-2.5 flex items-baseline justify-between">
                            <span className="text-ink-muted text-xs">
                              {paceText(limit, spent, month)}
                            </span>
                            <span className="relative z-10 flex items-center gap-3">
                              <button
                                type="button"
                                onClick={() => startEdit(budget)}
                                className="text-ink-muted hover:text-iris inline-flex items-center gap-1 text-xs"
                              >
                                <Pencil size={14} />
                                Edit
                              </button>
                              <button
                                type="button"
                                onClick={() => setConfirmDeleteId(budget.id)}
                                className="text-ink-muted hover:text-rose inline-flex items-center gap-1 text-xs"
                              >
                                <Trash2 size={14} />
                                Remove
                              </button>
                            </span>
                          </div>
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {initialBudgets.length === 0 && (
            <p className="text-ink-muted mt-4.5 text-sm">No budgets set for this month yet.</p>
          )}

          {available.length > 0 && (
            <div className="border-line bg-iris-soft mt-3 rounded-[18px] border border-dashed p-4">
              {showAddForm ? (
                <form onSubmit={handleAdd} className="flex flex-col items-stretch gap-2.5">
                  <div className="flex-1">
                    <label className="text-ink-muted mb-1.5 block text-[11px] font-semibold tracking-[0.06em] uppercase">
                      Category
                    </label>
                    <Select
                      className="bg-paper-raised rounded-[9px]"
                      value={selectedCategoryId}
                      onChange={(e) => setCategoryId(e.target.value)}
                      required
                    >
                      {available.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </Select>
                  </div>
                  <div className="w-full">
                    <label className="text-ink-muted mb-1.5 block text-[11px] font-semibold tracking-[0.06em] uppercase">
                      Monthly limit
                    </label>
                    <Input
                      className="bg-paper-raised rounded-[9px] font-mono"
                      type="number"
                      step="0.01"
                      placeholder="0.00"
                      value={limitAmount}
                      onChange={(e) => setLimitAmount(e.target.value)}
                      required
                      autoFocus
                    />
                  </div>
                  <div className="flex gap-2.5">
                    <button
                      type="button"
                      onClick={() => setShowAddForm(false)}
                      className="border-line text-ink bg-paper-raised flex-1 rounded-full border py-2.5 text-[14px] font-medium"
                    >
                      Cancel
                    </button>
                    <Button
                      type="submit"
                      icon={Check}
                      loading={pending}
                      className="flex-[1.3] justify-center py-2.5"
                    >
                      Set budget
                    </Button>
                  </div>
                </form>
              ) : (
                <>
                  <div className="font-display text-[16.5px] font-semibold">Add a budget</div>
                  <p className="text-ink-muted mt-1.5 text-[12.5px] leading-snug">
                    {initialBudgets.length} of your {categories.length} categories have a limit.
                    Spending in the other {available.length} never shows a status.
                  </p>
                  <button
                    type="button"
                    onClick={() => setShowAddForm(true)}
                    className="bg-iris text-paper-raised mt-3.5 block w-full rounded-full py-3 text-[14px] font-semibold"
                  >
                    New budget
                  </button>
                </>
              )}
            </div>
          )}
        </>
      )}
      <ConfirmDialog
        open={confirmDeleteId !== null}
        title="Remove budget"
        description={
          confirmDeletingBudget
            ? `Clears the ${confirmDeletingBudget.categoryName} budget from ${monthLabel(confirmDeletingBudget.month)} onward, including past months. You can set a new one anytime.`
            : ''
        }
        confirmLabel="Remove"
        pending={deletePending}
        onConfirm={() => confirmDeleteId && handleDelete(confirmDeleteId)}
        onCancel={() => setConfirmDeleteId(null)}
      />
    </div>
  );
};
