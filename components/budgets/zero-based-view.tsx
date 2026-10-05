'use client';

import { useState } from 'react';
import Link from 'next/link';
import { ArrowRightLeft, Check, Target } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input, Label, Select } from '@/components/ui/field';
import { Modal } from '@/components/ui/modal';
import { BudgetRing } from '@/components/budgets/budget-ring';
import { deleteJSON, getJSON, patchJSON, postJSON, putJSON } from '@/lib/api-client';
import { cn } from '@/lib/cn';
import { monthLabel } from '@/lib/period-selection';
import type { FrontendZbbCategory, FrontendZbbMonth } from '@/lib/services/zeroBased';

const MONEY = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const money = (value: string | number): string => MONEY.format(Number(value));

const withoutKey = (record: Record<string, string>, key: string): Record<string, string> => {
  const next = { ...record };
  delete next[key];
  return next;
};

/**
 * How much of what the category had to spend this month (carried in plus
 * assigned) its activity used, matching what the Overview rings show. Spending
 * with nothing funded reads as fully over.
 */
const spentFraction = (category: FrontendZbbCategory): number => {
  const funded = Number(category.carriedIn) + Number(category.assigned);
  const spent = Math.max(Number(category.activity), 0);
  if (funded <= 0) return spent > 0 ? 2 : 0;
  return spent / funded;
};

type MoveDraft = { fromCategoryId: string; toCategoryId: string; amount: string };
type TargetDraft = { category: FrontendZbbCategory; amount: string };

const readyTone = (ready: number): { text: string; label: string; detail: string } => {
  if (ready < 0) {
    return {
      text: 'text-rose',
      label: 'Over-assigned',
      detail: "You've assigned more than you have. Take money back from a category to fix it.",
    };
  }
  if (ready > 0) {
    return {
      text: 'text-iris',
      label: 'Ready to assign',
      detail: 'Give these dollars a job. Assigning to savings counts.',
    };
  }
  return { text: 'text-sky', label: 'All assigned', detail: 'Every dollar has a job.' };
};

/**
 * Zero-based Budgets screen: Ready to Assign up top, then one row per
 * category with an editable assigned amount. Every write returns the
 * recomputed month, so the screen updates from the response instead of a
 * full refresh. The page keys this component by month, so navigating resets
 * the local state.
 */
export const ZeroBasedView = ({
  initialMonth,
}: {
  initialMonth: FrontendZbbMonth;
}): React.ReactElement => {
  const [data, setData] = useState(initialMonth);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [savingId, setSavingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [move, setMove] = useState<MoveDraft | null>(null);
  const [movePending, setMovePending] = useState(false);
  const [moveError, setMoveError] = useState<string | null>(null);
  const [targetsPending, setTargetsPending] = useState(false);
  const [targetEdit, setTargetEdit] = useState<TargetDraft | null>(null);
  const [targetPending, setTargetPending] = useState(false);
  const [targetError, setTargetError] = useState<string | null>(null);

  const { month, startMonth, categories, uncategorizedOnBudget } = data;
  const ready = Number(data.readyToAssign);
  const tone = readyTone(ready);
  const hasTargets = categories.some((c) => c.target !== null);

  if (month < startMonth) {
    return (
      <div className="border-line bg-paper-raised mt-6.5 rounded-2xl border border-dashed p-8 text-center">
        <p className="text-ink-muted text-sm">
          Zero-based budgeting started in {monthLabel(startMonth)}. Earlier months have no
          assignments.
        </p>
      </div>
    );
  }

  const saveAssigned = async (category: FrontendZbbCategory): Promise<void> => {
    const draft = drafts[category.categoryId];
    if (draft === undefined) return;
    if (draft.trim() === '' || Number(draft) === Number(category.assigned)) {
      setDrafts((prev) => withoutKey(prev, category.categoryId));
      return;
    }
    setSavingId(category.categoryId);
    setError(null);
    const res = await putJSON<FrontendZbbMonth>('/api/budgets/assignments', {
      categoryId: category.categoryId,
      month,
      amount: draft,
    });
    setSavingId(null);
    if (!res.ok) {
      setError(res.error ?? `Could not update ${category.categoryName}.`);
      return;
    }
    setDrafts((prev) => withoutKey(prev, category.categoryId));
    setData(res.data);
  };

  const openMove = (category: FrontendZbbCategory): void => {
    const overspent = Number(category.available) < 0;
    // "Cover" pulls money into an overspent row; "Move" pushes money out
    const other = categories.find(
      (c) => c.categoryId !== category.categoryId && (!overspent || Number(c.available) > 0),
    );
    setMoveError(null);
    setMove({
      fromCategoryId: overspent ? (other?.categoryId ?? '') : category.categoryId,
      toCategoryId: overspent ? category.categoryId : (other?.categoryId ?? ''),
      amount: overspent ? Math.abs(Number(category.available)).toFixed(2) : '',
    });
  };

  const submitMove = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!move) return;
    setMovePending(true);
    setMoveError(null);
    const res = await postJSON<FrontendZbbMonth>('/api/budgets/assignments/move', {
      ...move,
      month,
    });
    setMovePending(false);
    if (!res.ok) {
      setMoveError(res.error ?? 'Could not move that money.');
      return;
    }
    setData(res.data);
    setMove(null);
  };

  const assignTargets = async (): Promise<void> => {
    setTargetsPending(true);
    setError(null);
    const res = await postJSON<FrontendZbbMonth>('/api/budgets/assignments/targets', { month });
    setTargetsPending(false);
    if (!res.ok) {
      setError(res.error ?? 'Could not assign to targets.');
      return;
    }
    setData(res.data);
  };

  const openTarget = (category: FrontendZbbCategory): void => {
    setTargetError(null);
    setTargetEdit({ category, amount: category.target ?? '' });
  };

  /**
   * Targets are spending limits, written through the same /api/budgets calls
   * the limits screen uses: a target set in this month is patched in place, one
   * carried from an earlier month forks a new value from this month on.
   */
  const saveTarget = async (remove: boolean): Promise<void> => {
    if (!targetEdit) return;
    const { category, amount } = targetEdit;
    setTargetPending(true);
    setTargetError(null);
    const res = remove
      ? await deleteJSON(`/api/budgets/${category.targetBudgetId}`)
      : category.targetBudgetId && category.targetMonth === month
        ? await patchJSON(`/api/budgets/${category.targetBudgetId}`, { limitAmount: amount })
        : await postJSON('/api/budgets', {
            categoryId: category.categoryId,
            month,
            limitAmount: amount,
          });
    if (!res.ok) {
      setTargetPending(false);
      setTargetError(remove ? 'Could not remove that target.' : 'Enter an amount above zero.');
      return;
    }
    const refreshed = await getJSON<FrontendZbbMonth>(`/api/budgets/assignments?month=${month}`);
    setTargetPending(false);
    if (refreshed.ok) setData(refreshed.data);
    setTargetEdit(null);
  };

  return (
    <div className="mt-6.5">
      <div
        className="border-line bg-paper-raised rounded-[18px] border p-5.5"
        data-testid="ready-to-assign"
      >
        <div className="flex items-baseline justify-between gap-2.5">
          <span className="text-ink-muted text-[11px] tracking-[0.08em] uppercase">
            {tone.label}
          </span>
          <span className="text-ink-muted text-[11px] tracking-[0.04em] uppercase">
            {monthLabel(month)}
          </span>
        </div>
        <div className={cn('font-display mt-2 text-2xl font-semibold tabular-nums', tone.text)}>
          {money(ready)}
        </div>
        <p className="text-ink-muted mt-1.5 text-[12.5px] leading-snug">{tone.detail}</p>
        {hasTargets && (
          <Button
            type="button"
            icon={Target}
            loading={targetsPending}
            onClick={assignTargets}
            className="mt-3.5"
          >
            Assign to targets
          </Button>
        )}
        {uncategorizedOnBudget.count > 0 && (
          <>
            <div className="bg-line my-3.5 h-px" />
            <p className="text-ink-muted text-[12.5px] leading-snug">
              {uncategorizedOnBudget.count} uncategorized expense
              {uncategorizedOnBudget.count === 1 ? '' : 's'} ({money(uncategorizedOnBudget.total)})
              came out of Ready to Assign instead of a category.
            </p>
            <Link
              href="/categorize"
              className="border-line text-iris mt-2 inline-flex min-h-10 items-center rounded-full border px-3.5 text-[12.5px] font-semibold"
            >
              Categorize them
            </Link>
          </>
        )}
      </div>

      {error && (
        <p className="text-rose mt-3 text-sm" role="alert">
          {error}
        </p>
      )}

      {categories.length === 0 ? (
        <div className="border-line bg-paper-raised mt-4.5 flex flex-col items-center gap-3 rounded-2xl border border-dashed p-8 text-center">
          <p className="text-ink-muted text-sm">
            You don&apos;t have any categories yet. Add some to start assigning money.
          </p>
          <Link href="/categories" className="text-iris text-sm font-semibold">
            Add categories
          </Link>
        </div>
      ) : (
        <div className="border-line bg-paper-raised mt-4.5 overflow-hidden rounded-[18px] border">
          <div className="text-ink-muted border-line hidden grid-cols-[minmax(0,1fr)_9rem_7rem_7rem_5.5rem] gap-3 border-b px-5 py-2.5 text-[11px] tracking-[0.06em] uppercase sm:grid">
            <span>Category</span>
            <span className="text-right">Assigned</span>
            <span className="text-right">Activity</span>
            <span className="text-right">Available</span>
            <span />
          </div>
          <ul>
            {categories.map((c) => {
              const available = Number(c.available);
              const overspent = available < 0;
              return (
                <li
                  key={c.categoryId}
                  data-testid={`zbb-row-${c.categoryName}`}
                  className={cn(
                    'border-line grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 border-b px-5 py-3 last:border-b-0 sm:grid-cols-[minmax(0,1fr)_9rem_7rem_7rem_5.5rem]',
                    overspent && 'bg-rose-soft/40',
                  )}
                >
                  <div className="flex min-w-0 items-center gap-3">
                    <BudgetRing fraction={spentFraction(c)} size={36} />
                    <div className="min-w-0">
                      <div className="font-display truncate text-[15px] font-semibold">
                        {c.categoryName}
                      </div>
                      <div className="text-ink-muted flex flex-wrap items-center gap-x-1.5 font-mono text-[11.5px] tabular-nums">
                        {Number(c.carriedIn) !== 0 && (
                          <span>{money(c.carriedIn)} carried in ·</span>
                        )}
                        <button
                          type="button"
                          onClick={() => openTarget(c)}
                          className="hover:text-iris inline-flex items-center gap-1 whitespace-nowrap"
                          aria-label={`${c.target === null ? 'Set' : 'Edit'} target for ${c.categoryName}`}
                        >
                          <Target size={12} />
                          {c.target === null ? 'Set target' : `target ${money(c.target)}`}
                        </button>
                      </div>
                    </div>
                  </div>
                  <div className="col-start-2 row-start-1 flex w-24 items-center justify-end gap-1 justify-self-end sm:col-start-auto sm:row-start-auto sm:w-auto">
                    <label htmlFor={`assigned-${c.categoryId}`} className="sr-only">
                      Assigned to {c.categoryName}
                    </label>
                    <Input
                      id={`assigned-${c.categoryId}`}
                      className="w-28 rounded-[9px] text-right font-mono"
                      type="number"
                      step="0.01"
                      inputMode="decimal"
                      value={drafts[c.categoryId] ?? c.assigned}
                      disabled={savingId === c.categoryId}
                      onChange={(e) =>
                        setDrafts((prev) => ({ ...prev, [c.categoryId]: e.target.value }))
                      }
                      onBlur={() => saveAssigned(c)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') e.currentTarget.blur();
                        if (e.key === 'Escape') {
                          setDrafts((prev) => withoutKey(prev, c.categoryId));
                        }
                      }}
                    />
                  </div>
                  <div className="text-ink-muted font-mono text-[13px] tabular-nums sm:text-right">
                    <span className="sm:hidden">Spent </span>
                    {money(c.activity)}
                  </div>
                  <div className="flex items-center justify-end gap-2 sm:contents">
                    <span
                      data-testid="zbb-available"
                      className={cn(
                        'justify-self-end rounded-full px-2.5 py-0.5 font-mono text-[13px] font-semibold tabular-nums',
                        overspent
                          ? 'bg-rose-soft text-rose'
                          : available > 0
                            ? 'bg-sky-soft text-sky'
                            : 'bg-paper-sunk text-ink-muted',
                      )}
                    >
                      {money(c.available)}
                    </span>
                    <button
                      type="button"
                      onClick={() => openMove(c)}
                      className={cn(
                        'inline-flex items-center justify-end gap-1 text-xs',
                        overspent ? 'text-rose font-semibold' : 'text-ink-muted hover:text-iris',
                      )}
                    >
                      <ArrowRightLeft size={14} />
                      {overspent ? 'Cover' : 'Move'}
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <p className="text-ink-muted mt-3 text-xs leading-snug">
        A target is how much a category should have to spend each month. It&apos;s the same number
        as the category&apos;s spending limit, so it carries into later months until you change it.
      </p>

      <Modal
        open={targetEdit !== null}
        onClose={() => setTargetEdit(null)}
        title={targetEdit ? `Target for ${targetEdit.category.categoryName}` : 'Target'}
      >
        {targetEdit && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void saveTarget(false);
            }}
            className="flex flex-col gap-3"
          >
            <div>
              <Label htmlFor="target-amount">Monthly target</Label>
              <Input
                id="target-amount"
                className="font-mono"
                type="number"
                step="0.01"
                min="0.01"
                inputMode="decimal"
                autoFocus
                value={targetEdit.amount}
                onChange={(e) => setTargetEdit({ ...targetEdit, amount: e.target.value })}
                required
              />
              <p className="text-ink-muted mt-1 text-xs">
                Applies from {monthLabel(month)} onward. Earlier months keep their target.
              </p>
            </div>
            {targetEdit.category.targetMonth !== null &&
              targetEdit.category.targetMonth < month && (
                <p className="text-ink-muted text-xs">
                  This target was set in {monthLabel(targetEdit.category.targetMonth)}. Removing it
                  clears it from then onward, including earlier months.
                </p>
              )}
            {targetError && (
              <p className="text-rose text-sm" role="alert">
                {targetError}
              </p>
            )}
            <div className="flex gap-2.5">
              {targetEdit.category.targetBudgetId && (
                <Button
                  type="button"
                  variant="danger"
                  disabled={targetPending}
                  onClick={() => saveTarget(true)}
                  title={`Clears the target from ${monthLabel(targetEdit.category.targetMonth ?? month)} onward`}
                >
                  Remove
                </Button>
              )}
              <Button type="submit" icon={Check} loading={targetPending} className="flex-1">
                Save target
              </Button>
            </div>
          </form>
        )}
      </Modal>

      <Modal open={move !== null} onClose={() => setMove(null)} title="Move money">
        {move && (
          <form onSubmit={submitMove} className="flex flex-col gap-3">
            <div>
              <Label htmlFor="move-from">From</Label>
              <Select
                id="move-from"
                value={move.fromCategoryId}
                onChange={(e) => setMove({ ...move, fromCategoryId: e.target.value })}
                required
              >
                <option value="" disabled>
                  Pick a category
                </option>
                {categories.map((c) => (
                  <option key={c.categoryId} value={c.categoryId}>
                    {c.categoryName} ({money(c.available)})
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <Label htmlFor="move-to">To</Label>
              <Select
                id="move-to"
                value={move.toCategoryId}
                onChange={(e) => setMove({ ...move, toCategoryId: e.target.value })}
                required
              >
                <option value="" disabled>
                  Pick a category
                </option>
                {categories.map((c) => (
                  <option key={c.categoryId} value={c.categoryId}>
                    {c.categoryName} ({money(c.available)})
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <Label htmlFor="move-amount">Amount</Label>
              <Input
                id="move-amount"
                className="font-mono"
                type="number"
                step="0.01"
                min="0.01"
                inputMode="decimal"
                value={move.amount}
                onChange={(e) => setMove({ ...move, amount: e.target.value })}
                required
              />
            </div>
            {moveError && (
              <p className="text-rose text-sm" role="alert">
                {moveError}
              </p>
            )}
            <Button type="submit" icon={Check} loading={movePending} className="justify-center">
              Move money
            </Button>
          </form>
        )}
      </Modal>
    </div>
  );
};
