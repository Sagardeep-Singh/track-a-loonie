'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Archive, Check, Pencil, Goal, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Input, Select } from '@/components/ui/field';
import { MonthPicker } from '@/components/ui/month-picker';
import { deleteJSON, patchJSON, postJSON } from '@/lib/api-client';
import type { GoalStatus } from '@/lib/budgets/savings-goal-math';
import { cn } from '@/lib/cn';
import { monthsBetween, shiftMonth } from '@/lib/date';
import { monthLabel } from '@/lib/period-selection';
import type { FrontendCategory } from '@/lib/services/categories';
import type { FrontendSavingsGoal } from '@/lib/services/savingsGoals';

const MONEY = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const money = (value: string | number): string => MONEY.format(Number(value));

const STATUS: Record<GoalStatus, { label: string; tone: string; dot: string }> = {
  ON_TRACK: { label: 'On track', tone: 'text-sky', dot: 'bg-sky' },
  FUNDED: { label: 'Funded', tone: 'text-sky', dot: 'bg-sky' },
  BEHIND: { label: 'Behind', tone: 'text-iris', dot: 'bg-iris' },
  OVERDUE: { label: 'Overdue', tone: 'text-rose', dot: 'bg-rose' },
  NOT_STARTED: { label: 'Not started', tone: 'text-ink-muted', dot: 'bg-ink-muted' },
};

/** how many upcoming months the schedule disclosure lists */
const SCHEDULE_PREVIEW = 12;

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
      <p className="text-ink-muted mt-1.5 text-[12.5px] leading-snug">
        {zeroBased
          ? 'Assign to a goal’s category each month. Spending from that category later is covered by what you saved.'
          : 'Transfers to savings tagged with a goal’s category count as contributions. Spending tagged with it later is covered by what you saved.'}
      </p>

      {goals.length === 0 ? (
        <p className="text-ink-muted mt-4.5 text-sm">No savings goals yet.</p>
      ) : (
        <div className="mt-4.5 grid grid-cols-1 gap-4 lg:grid-cols-2">
          {goals.map((goal) => {
            const status = STATUS[goal.status];
            const target = Number(goal.targetAmount);
            const saved = Number(goal.saved);
            const fraction = target > 0 ? Math.min(Math.max(saved / target, 0), 1) : 0;
            const need = Number(goal.needThisMonth);
            const spent = Number(goal.spent);
            return (
              <article
                key={goal.id}
                data-testid={`goal-${goal.categoryName}`}
                className="border-line bg-paper-raised rounded-2xl border p-4.5 sm:p-5.5"
              >
                {draft?.goalId === goal.id ? (
                  <>
                    <h3 className="font-display mb-3 flex min-w-0 items-center gap-1.5 text-base font-semibold">
                      <Goal size={16} className="text-iris shrink-0" />
                      <span className="truncate">Edit {goal.categoryName}</span>
                    </h3>
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
                    <div className="flex items-baseline justify-between gap-2.5">
                      <h3 className="font-display flex min-w-0 items-center gap-1.5 text-base font-semibold">
                        <Goal size={16} className="text-iris shrink-0" />
                        <span className="truncate">{goal.categoryName}</span>
                      </h3>
                      <span
                        className={cn(
                          'flex shrink-0 items-center gap-1.5 text-[11px] font-semibold tracking-[0.04em] uppercase',
                          status.tone,
                        )}
                      >
                        <span className={cn('size-1.5 rounded-full', status.dot)} />
                        {status.label}
                      </span>
                    </div>
                    <div className="text-ink-muted mt-1.5 font-mono text-[13px] tabular-nums">
                      {money(goal.saved)} of {money(goal.targetAmount)} by{' '}
                      {monthLabel(goal.targetMonth)}
                    </div>
                    <div
                      className="bg-paper-sunk mt-2.5 flex h-1.75 overflow-hidden rounded-full"
                      role="progressbar"
                      aria-label={`${goal.categoryName} progress`}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={Math.round(fraction * 100)}
                    >
                      <span
                        className={cn('block', status.dot)}
                        style={{ width: `${Math.round(fraction * 100)}%` }}
                      />
                    </div>
                    {need > 0 ? (
                      <div className="mt-3">
                        <div className={cn('font-display text-lg font-semibold', status.tone)}>
                          Save {money(need)} this month
                        </div>
                        <div className="text-ink-muted mt-0.5 text-xs">
                          {money(goal.contributedThisMonth)} put aside so far
                          {goal.monthsLeft > 1 ? ` · ${goal.monthsLeft} months left` : ''}
                          {goal.status === 'BEHIND' && ' · raised to catch up'}
                        </div>
                      </div>
                    ) : goal.status === 'NOT_STARTED' ? (
                      <p className="text-ink-muted mt-3 text-xs">
                        Starts {monthLabel(goal.startMonth)}.
                      </p>
                    ) : (
                      <p className="text-sky font-display mt-3 text-lg font-semibold">
                        Nothing more to save
                      </p>
                    )}
                    {spent > 0 && (
                      <p className="text-ink-muted mt-2 text-xs">
                        Spent {money(goal.spent)} from this goal · {money(goal.balance)} left
                      </p>
                    )}
                    {goal.schedule.length > 1 && (
                      <details className="mt-2.5">
                        <summary className="text-ink-muted hover:text-iris cursor-pointer text-xs">
                          Monthly plan
                        </summary>
                        <ul className="text-ink-muted mt-1.5 grid grid-cols-2 gap-x-4 gap-y-0.5 font-mono text-[12px] tabular-nums">
                          {goal.schedule.slice(0, SCHEDULE_PREVIEW).map((share) => (
                            <li key={share.month} className="flex justify-between gap-2">
                              <span>{monthLabel(share.month)}</span>
                              <span>{money(share.amount)}</span>
                            </li>
                          ))}
                        </ul>
                        {goal.schedule.length > SCHEDULE_PREVIEW && (
                          <p className="text-ink-muted mt-1 text-[11px]">
                            and {goal.schedule.length - SCHEDULE_PREVIEW} more months
                          </p>
                        )}
                      </details>
                    )}
                    <div className="mt-3 flex items-center justify-end gap-3">
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
                        aria-label={`Delete ${goal.categoryName} goal`}
                      >
                        <Trash2 size={14} />
                        Delete
                      </button>
                    </div>
                  </>
                )}
              </article>
            );
          })}
        </div>
      )}

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
        title="Delete savings goal"
        description={
          confirmDelete
            ? `Deletes the ${confirmDelete.categoryName} goal. The category and its transactions stay, and spending in it counts as normal spending again.`
            : ''
        }
        confirmLabel="Delete"
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
