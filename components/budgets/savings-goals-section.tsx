'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Archive, Check, Goal, Pencil, Trash2 } from 'lucide-react';
import { AnimatedMoney } from '@/components/ui/animated-money';
import { BudgetRing } from '@/components/budgets/budget-ring';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Input, Select } from '@/components/ui/field';
import { MonthPicker } from '@/components/ui/month-picker';
import { deleteJSON, patchJSON, postJSON } from '@/lib/api-client';
import type { GoalStatus } from '@/lib/budgets/savings-goal-math';
import { cn } from '@/lib/cn';
import { monthsBetween, shiftMonth } from '@/lib/date';
import { monthLabel, monthToRange } from '@/lib/period-selection';
import { transactionsHref } from '@/lib/transactions/transaction-filters';
import type { FrontendCategory } from '@/lib/services/categories';
import type { FrontendSavingsGoal } from '@/lib/services/savingsGoals';

const MONEY = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const money = (value: string | number): string => MONEY.format(Number(value));

type StatusStyle = { label: string; tone: string; dot: string; ring: 'sky' | 'iris' | 'rose' };

// same tones as the budget cards: sky is fine, iris needs attention, rose is late
const STATUS: Record<GoalStatus, StatusStyle> = {
  ON_TRACK: { label: 'On track', tone: 'text-sky', dot: 'bg-sky', ring: 'sky' },
  FUNDED: { label: 'Funded', tone: 'text-sky', dot: 'bg-sky', ring: 'sky' },
  BEHIND: { label: 'Behind', tone: 'text-iris', dot: 'bg-iris', ring: 'iris' },
  OVERDUE: { label: 'Overdue', tone: 'text-rose', dot: 'bg-rose', ring: 'rose' },
  NOT_STARTED: { label: 'Not started', tone: 'text-ink-muted', dot: 'bg-ink-muted', ring: 'sky' },
};

const MONTH_ONLY = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'long' });
const monthOnly = (month: number): string =>
  MONTH_ONLY.format(new Date(Date.UTC(Math.floor(month / 100), (month % 100) - 1, 1)));

/** the footer line, like a budget card's pace text */
const paceText = (goal: FrontendSavingsGoal): string => {
  const by = `by ${monthLabel(goal.targetMonth)}`;
  switch (goal.status) {
    case 'FUNDED':
      return Number(goal.spent) > 0 ? `$${goal.balance} left to spend` : `Reached ${by}`;
    case 'OVERDUE':
      return `Was due ${monthLabel(goal.targetMonth)}`;
    case 'NOT_STARTED':
      return `Due ${by}`;
    case 'BEHIND':
      return `Behind, raised to catch up ${by}`;
    default:
      return `$${goal.contributedThisMonth} put aside, ${goal.monthsLeft} ${goal.monthsLeft === 1 ? 'month' : 'months'} left`;
  }
};

type Draft = {
  goalId: string | null;
  categoryId: string;
  newCategoryName: string;
  targetAmount: string;
  targetMonth: number | null;
  startingAmount: string;
};

const NEW_CATEGORY = '__new__';
/** same cap the service enforces on the target month */
const MAX_MONTHS_OUT = 120;

// same field styling as the "Add a budget" form on the limits screen
const LABEL_CLASS =
  'text-ink-muted mb-1.5 block text-[11px] font-semibold tracking-[0.06em] uppercase';
const FIELD_CLASS = 'bg-paper-raised rounded-[9px]';

/**
 * Rough monthly amount for the form preview: an even split from this month to
 * the target month. The card shows the exact figure (with rounding and past
 * contributions) once the goal is saved.
 */
const previewText = (draft: Draft, month: number): string | null => {
  const target = Number(draft.targetAmount);
  const starting = Number(draft.startingAmount || 0);
  if (!draft.targetMonth || !(target > 0) || starting >= target) return null;
  const months = monthsBetween(month, draft.targetMonth) + 1;
  if (months < 1) return null;
  const perMonth = MONEY.format((target - starting) / months);
  return months === 1
    ? `Save ${perMonth} this month`
    : `About ${perMonth} a month for ${months} months`;
};

const GoalForm = ({
  draft,
  onChange,
  pickable,
  zeroBased,
  month,
  pending,
  error,
  onCancel,
  onSubmit,
}: {
  draft: Draft;
  onChange: (draft: Draft) => void;
  pickable: FrontendCategory[];
  zeroBased: boolean;
  month: number;
  pending: boolean;
  error: string | null;
  onCancel: () => void;
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => void;
}): React.ReactElement => {
  const isNew = draft.goalId === null;
  const idPrefix = draft.goalId ?? 'new';
  const preview = previewText(draft, month);
  return (
    <form onSubmit={onSubmit} className="flex flex-col items-stretch gap-2.5">
      {isNew && (
        <div>
          <label htmlFor={`${idPrefix}-goal-category`} className={LABEL_CLASS}>
            Category
          </label>
          <Select
            id={`${idPrefix}-goal-category`}
            className={FIELD_CLASS}
            value={draft.categoryId}
            onChange={(e) => onChange({ ...draft, categoryId: e.target.value })}
          >
            <option value={NEW_CATEGORY}>New category…</option>
            {pickable.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
          {draft.categoryId === NEW_CATEGORY && (
            <Input
              aria-label="New category name"
              className={cn(FIELD_CLASS, 'mt-2')}
              placeholder="Trip to Japan"
              maxLength={60}
              value={draft.newCategoryName}
              onChange={(e) => onChange({ ...draft, newCategoryName: e.target.value })}
              required
              autoFocus
            />
          )}
          <p className="text-ink-muted mt-1 text-xs">
            Categories with a spending limit can&apos;t hold a goal.
          </p>
        </div>
      )}
      <div>
        <label htmlFor={`${idPrefix}-goal-target`} className={LABEL_CLASS}>
          Target amount
        </label>
        <Input
          id={`${idPrefix}-goal-target`}
          className={cn(FIELD_CLASS, 'font-mono')}
          type="number"
          step="0.01"
          min="0.01"
          inputMode="decimal"
          placeholder="0.00"
          value={draft.targetAmount}
          onChange={(e) => onChange({ ...draft, targetAmount: e.target.value })}
          required
          autoFocus={!isNew}
        />
      </div>
      <div>
        <span className={LABEL_CLASS}>
          Reach it by
          {draft.targetMonth !== null && (
            <span className="text-ink tracking-normal normal-case">
              {' '}
              · {monthLabel(draft.targetMonth)}
            </span>
          )}
        </span>
        <div className="border-line bg-paper-raised rounded-[9px] border px-3 pt-1 pb-3">
          <MonthPicker
            label="Reach it by"
            value={draft.targetMonth}
            onChange={(targetMonth) => onChange({ ...draft, targetMonth })}
            min={month}
            max={shiftMonth(month, MAX_MONTHS_OUT)}
          />
        </div>
      </div>
      <div>
        <label htmlFor={`${idPrefix}-goal-starting`} className={LABEL_CLASS}>
          {zeroBased ? 'Already saved in off-budget accounts' : 'Already saved'}
        </label>
        <Input
          id={`${idPrefix}-goal-starting`}
          className={cn(FIELD_CLASS, 'font-mono')}
          type="number"
          step="0.01"
          min="0"
          inputMode="decimal"
          placeholder="0.00"
          value={draft.startingAmount}
          onChange={(e) => onChange({ ...draft, startingAmount: e.target.value })}
        />
        {zeroBased && (
          <p className="text-ink-muted mt-1 text-xs">
            Money in on-budget accounts should be assigned to the goal&apos;s category instead, so
            it isn&apos;t counted twice.
          </p>
        )}
      </div>
      {preview && <p className="text-iris text-[12.5px] font-semibold">{preview}</p>}
      {error && (
        <p className="text-rose text-sm" role="alert">
          {error}
        </p>
      )}
      <div className="flex gap-2.5">
        <button
          type="button"
          onClick={onCancel}
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
          {isNew ? 'Add goal' : 'Save goal'}
        </Button>
      </div>
    </form>
  );
};

export const SavingsGoalsSection = ({
  goals,
  categories,
  unavailableCategoryIds,
  month,
  zeroBased,
}: {
  goals: FrontendSavingsGoal[];
  categories: FrontendCategory[];
  /** categories with a spending limit or another goal can't hold a new goal */
  unavailableCategoryIds: string[];
  month: number;
  zeroBased: boolean;
}): React.ReactElement => {
  const router = useRouter();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<FrontendSavingsGoal | null>(null);
  const [deletePending, setDeletePending] = useState(false);

  const unavailable = new Set(unavailableCategoryIds);
  const pickable = categories.filter((c) => !unavailable.has(c.id));

  const openNew = (): void => {
    setError(null);
    setDraft({
      goalId: null,
      categoryId: NEW_CATEGORY,
      newCategoryName: '',
      targetAmount: '',
      targetMonth: null,
      startingAmount: '',
    });
  };

  const openEdit = (goal: FrontendSavingsGoal): void => {
    setError(null);
    setDraft({
      goalId: goal.id,
      categoryId: goal.categoryId,
      newCategoryName: '',
      targetAmount: goal.targetAmount,
      targetMonth: goal.targetMonth,
      startingAmount: Number(goal.startingAmount) > 0 ? goal.startingAmount : '',
    });
  };

  const submit = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!draft) return;
    const { targetMonth } = draft;
    if (targetMonth === null) {
      setError('Pick the month you want to reach the target by.');
      return;
    }
    const amounts = {
      targetAmount: draft.targetAmount,
      targetMonth,
      startingAmount: draft.startingAmount === '' ? '0' : draft.startingAmount,
    };
    setPending(true);
    setError(null);
    const res = draft.goalId
      ? await patchJSON(`/api/savings-goals/${draft.goalId}`, amounts)
      : await postJSON(
          '/api/savings-goals',
          draft.categoryId === NEW_CATEGORY
            ? { ...amounts, newCategoryName: draft.newCategoryName }
            : { ...amounts, categoryId: draft.categoryId },
        );
    setPending(false);
    if (!res.ok) {
      setError(res.error ?? 'Could not save that goal. Check the amounts and month.');
      return;
    }
    setDraft(null);
    router.refresh();
  };

  const archive = async (goal: FrontendSavingsGoal): Promise<void> => {
    await patchJSON(`/api/savings-goals/${goal.id}`, { archived: true });
    router.refresh();
  };

  const remove = async (goal: FrontendSavingsGoal): Promise<void> => {
    setDeletePending(true);
    await deleteJSON(`/api/savings-goals/${goal.id}`);
    setDeletePending(false);
    setConfirmDelete(null);
    router.refresh();
  };

  const totalNeed = goals.reduce((sum, g) => sum + Number(g.needThisMonth), 0);
  const totalContributed = goals.reduce(
    (sum, g) => sum + Math.max(Number(g.contributedThisMonth), 0),
    0,
  );
  const totalFraction = totalNeed > 0 ? totalContributed / totalNeed : 1;
  const summaryStatus: StatusStyle = goals.some((g) => g.status === 'OVERDUE')
    ? STATUS.OVERDUE
    : goals.some((g) => g.status === 'BEHIND')
      ? STATUS.BEHIND
      : goals.every((g) => g.status === 'FUNDED')
        ? STATUS.FUNDED
        : STATUS.ON_TRACK;
  const modeHint = zeroBased
    ? 'Assign to a goal’s category each month. Spending from that category later is covered by what you saved.'
    : 'Transfers to savings tagged with a goal’s category count as contributions. Spending tagged with it later is covered by what you saved.';

  return (
    <section
      id="savings-goals"
      className="mt-8 scroll-mt-6"
      aria-labelledby="savings-goals-heading"
    >
      <div className="flex items-baseline justify-between gap-3">
        <h2 id="savings-goals-heading" className="font-display text-lg font-semibold">
          Savings goals
        </h2>
      </div>

      {goals.length > 0 && (
        <div className="border-line bg-paper-raised mt-4.5 rounded-[18px] border p-5.5">
          <div className="flex items-baseline justify-between gap-2.5">
            <span className="text-ink-muted text-[11px] tracking-[0.08em] uppercase">
              All {goals.length} goal{goals.length === 1 ? '' : 's'} · {monthOnly(month)}
            </span>
            <span
              className={cn(
                'flex items-center gap-1.5 text-[11px] font-semibold tracking-[0.04em] uppercase',
                summaryStatus.tone,
              )}
            >
              <span className={cn('size-1.5 rounded-full', summaryStatus.dot)} />
              {summaryStatus.label}
            </span>
          </div>
          <div className={cn('font-display mt-2 text-xl font-semibold', summaryStatus.tone)}>
            {totalNeed > 0
              ? `Save ${money(totalNeed)} this month`
              : 'Nothing more to save this month'}
          </div>
          <div className="text-ink-muted mt-1.5 font-mono text-[13px] tabular-nums">
            {money(totalContributed)} of {money(totalNeed)} put aside
          </div>
          <div className="bg-paper-sunk mt-3 flex h-1.75 overflow-hidden rounded-full">
            <span
              className={cn('block', summaryStatus.dot)}
              style={{ width: `${Math.round(Math.min(totalFraction, 1) * 100)}%` }}
            />
          </div>
          <div className="bg-line my-3.5 h-px" />
          <p className="text-ink-muted text-[12.5px] leading-snug">{modeHint}</p>
        </div>
      )}

      {goals.length > 0 && (
        <div className="mt-4.5 grid grid-cols-1 gap-4 lg:grid-cols-2">
          {goals.map((goal, index) => {
            const status = STATUS[goal.status];
            const target = Number(goal.targetAmount);
            const saved = Number(goal.saved);
            const need = Number(goal.needThisMonth);
            const spent = Number(goal.spent);
            const editing = draft?.goalId === goal.id;
            return (
              <article
                key={goal.id}
                data-testid={`goal-${goal.categoryName}`}
                style={{ '--i': index } as React.CSSProperties}
                className={cn(
                  'stagger-item border-line bg-paper-raised relative rounded-2xl border p-4.5 transition-colors sm:p-5.5',
                  editing ? 'border-iris' : 'hover:border-iris flex items-center gap-4 sm:gap-5.5',
                )}
              >
                {editing ? (
                  <>
                    <div className="font-display mb-3 text-base font-semibold">
                      Edit {goal.categoryName}
                    </div>
                    <GoalForm
                      draft={draft}
                      onChange={setDraft}
                      pickable={pickable}
                      zeroBased={zeroBased}
                      month={month}
                      pending={pending}
                      error={error}
                      onCancel={() => setDraft(null)}
                      onSubmit={submit}
                    />
                  </>
                ) : (
                  <>
                    <BudgetRing
                      fraction={target > 0 ? Math.max(saved / target, 0) : 0}
                      tone={status.ring}
                    />
                    <div className="min-w-0 flex-1">
                      {/* Stretched link, same as the budget cards: a click
                          anywhere opens the goal category's transactions. The
                          controls sit above it (relative z-10). */}
                      <Link
                        href={transactionsHref({
                          ...monthToRange(month),
                          categoryIds: [goal.categoryId],
                        })}
                        className="font-display block text-base font-semibold after:absolute after:inset-0 after:rounded-2xl"
                      >
                        {goal.categoryName}
                      </Link>
                      <div className={cn('font-display mt-1 text-lg font-semibold', status.tone)}>
                        {need > 0 ? (
                          <>
                            <AnimatedMoney value={need} /> to save
                          </>
                        ) : goal.status === 'NOT_STARTED' ? (
                          `Starts ${monthLabel(goal.startMonth)}`
                        ) : (
                          'Funded'
                        )}
                      </div>
                      <div className="text-ink-muted mt-1 font-mono text-[12.5px] tabular-nums">
                        ${saved.toFixed(2)} of ${target.toFixed(2)}
                        {spent > 0 && ` · spent $${spent.toFixed(2)}`}
                      </div>
                      <div className="mt-2.5 flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
                        <span className="text-ink-muted min-w-0 text-xs">{paceText(goal)}</span>
                        <span className="relative z-10 ml-auto flex shrink-0 items-center gap-3">
                          <button
                            type="button"
                            onClick={() => openEdit(goal)}
                            className="text-ink-muted hover:text-iris inline-flex items-center gap-1 text-xs"
                            aria-label={`Edit ${goal.categoryName} goal`}
                          >
                            <Pencil size={14} />
                            Edit
                          </button>
                          {goal.status === 'FUNDED' && (
                            <button
                              type="button"
                              onClick={() => archive(goal)}
                              className="text-ink-muted hover:text-iris inline-flex items-center gap-1 text-xs"
                              aria-label={`Archive ${goal.categoryName} goal`}
                            >
                              <Archive size={14} />
                              Archive
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => setConfirmDelete(goal)}
                            className="text-ink-muted hover:text-rose inline-flex items-center gap-1 text-xs"
                            aria-label={`Remove ${goal.categoryName} goal`}
                          >
                            <Trash2 size={14} />
                            Remove
                          </button>
                        </span>
                      </div>
                    </div>
                  </>
                )}
              </article>
            );
          })}
        </div>
      )}

      {goals.length === 0 && <p className="text-ink-muted mt-4.5 text-sm">No savings goals yet.</p>}

      <div className="border-line bg-iris-soft mt-3 rounded-[18px] border border-dashed p-4">
        {draft !== null && draft.goalId === null ? (
          <GoalForm
            draft={draft}
            onChange={setDraft}
            pickable={pickable}
            zeroBased={zeroBased}
            month={month}
            pending={pending}
            error={error}
            onCancel={() => setDraft(null)}
            onSubmit={submit}
          />
        ) : (
          <>
            <div className="font-display text-[16.5px] font-semibold">Add a savings goal</div>
            <p className="text-ink-muted mt-1.5 text-[12.5px] leading-snug">
              Pick an amount and a month. You&apos;ll see how much to put aside each month to get
              there.
            </p>
            <button
              type="button"
              onClick={openNew}
              className="bg-iris text-paper-raised mt-3.5 block w-full rounded-full py-3 text-[14px] font-semibold"
            >
              New goal
            </button>
          </>
        )}
      </div>

      <ConfirmDialog
        open={confirmDelete !== null}
        title="Remove savings goal"
        description={
          confirmDelete
            ? `Removes the ${confirmDelete.categoryName} goal. The category and its transactions stay, and spending in it counts as normal spending again.`
            : ''
        }
        confirmLabel="Remove"
        pending={deletePending}
        onConfirm={() => confirmDelete && remove(confirmDelete)}
        onCancel={() => setConfirmDelete(null)}
      />
    </section>
  );
};

/**
 * A one-line summary at the top of the Budgets page, so goals aren't only
 * found by scrolling past every budget. Links down to the goals section.
 */
export const SavingsGoalsShortcut = ({
  goals,
}: {
  goals: FrontendSavingsGoal[];
}): React.ReactElement => {
  const needCents = goals.reduce((sum, g) => sum + Math.round(Number(g.needThisMonth) * 100), 0);
  const savedCents = goals.reduce(
    (sum, g) => sum + Math.round(Number(g.contributedThisMonth) * 100),
    0,
  );
  const behind = goals.filter((g) => g.status === 'BEHIND' || g.status === 'OVERDUE').length;
  return (
    <a
      href="#savings-goals"
      data-testid="savings-goals-shortcut"
      className="border-line bg-paper-raised hover:border-iris mt-4 flex items-center gap-3 rounded-[14px] border px-4 py-3 transition-colors"
    >
      <Goal size={18} className="text-iris shrink-0" />
      <span className="min-w-0 flex-1 text-[13px] leading-snug">
        {goals.length === 0 ? (
          <span className="text-ink-muted">Saving for something? Set a savings goal.</span>
        ) : (
          <>
            <span className="font-semibold">
              {goals.length} savings goal{goals.length === 1 ? '' : 's'}
            </span>
            <span className="text-ink-muted">
              {needCents > 0
                ? ` · save ${money(needCents / 100)} this month, ${money(savedCents / 100)} so far`
                : ' · nothing more to save this month'}
            </span>
            {behind > 0 && <span className="text-iris"> · {behind} behind</span>}
          </>
        )}
      </span>
      <span className="text-iris shrink-0 text-[12.5px] font-semibold">
        {goals.length === 0 ? 'Add goal' : 'View goals'}
      </span>
    </a>
  );
};
