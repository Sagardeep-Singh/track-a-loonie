'use client';

import Link from 'next/link';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Calendar, ChevronDown, ChevronLeft, ChevronRight } from 'lucide-react';
import { BottomSheet } from '@/components/ui/bottom-sheet';
import { Button } from '@/components/ui/button';
import { Input, Label } from '@/components/ui/field';
import { cn } from '@/lib/cn';
import { usePlan } from '@/components/billing/plan-provider';
import {
  parseDateParam,
  periodSelectionLabel,
  rangeFromSelection,
  selectionFromRange,
  writePeriodCookie,
  type DateRange,
  type PeriodSelection,
} from '@/lib/period-selection';

const MONTH_SHORT = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short' });
const monthShort = (monthIndex: number): string =>
  MONTH_SHORT.format(new Date(Date.UTC(2000, monthIndex, 1)));

const currentMonth = (): number => {
  const now = new Date();
  return now.getUTCFullYear() * 100 + (now.getUTCMonth() + 1);
};

const shiftMonth = (month: number, delta: number): number => {
  const year = Math.floor(month / 100);
  const idx = (month % 100) - 1 + delta;
  const date = new Date(Date.UTC(year, idx, 1));
  return date.getUTCFullYear() * 100 + (date.getUTCMonth() + 1);
};

const pillClass = (active: boolean): string =>
  cn(
    'rounded-full px-3.5 py-2 text-[13px] font-medium',
    active ? 'bg-iris text-paper-raised' : 'border-line text-ink border',
  );

/** The preset pills, 12-month grid and (optionally) custom range, shared by
 * the popover and the sheet. */
const PeriodPickerBody = ({
  selection,
  now,
  viewYear,
  onPrevYear,
  onNextYear,
  onSelect,
  allowCustom,
  customDraft,
  onCustomDraftChange,
  floorMonth,
}: {
  selection: PeriodSelection;
  now: number;
  viewYear: number;
  onPrevYear: () => void;
  onNextYear: () => void;
  onSelect: (selection: PeriodSelection) => void;
  allowCustom: boolean;
  customDraft: { from: string; to: string };
  onCustomDraftChange: (draft: { from: string; to: string }) => void;
  /** oldest month the plan can browse; null = all history */
  floorMonth: number | null;
}): React.ReactElement => {
  // The body renders twice (anchored popover + the hidden mobile sheet), so
  // input ids must be per instance for each label to find its own input.
  const idPrefix = useId();
  const selectedMonth = selection.kind === 'month' ? selection.month : null;
  const lastMonth = shiftMonth(now, -1);
  const beforeFloor = (m: number): boolean => floorMonth !== null && m < floorMonth;
  const floorDate =
    floorMonth === null
      ? undefined
      : `${Math.floor(floorMonth / 100)}-${String(floorMonth % 100).padStart(2, '0')}-01`;
  const customInvalid =
    (!customDraft.from && !customDraft.to) ||
    (!!customDraft.from && !!customDraft.to && customDraft.from > customDraft.to);
  return (
    <>
      <div className="flex flex-wrap gap-1.5">
        <button
          type="button"
          onClick={() => onSelect({ kind: 'month', month: now })}
          className={pillClass(selectedMonth === now)}
        >
          This month
        </button>
        <button
          type="button"
          onClick={() => onSelect({ kind: 'month', month: lastMonth })}
          className={pillClass(selectedMonth === lastMonth)}
        >
          Last month
        </button>
        {allowCustom && (
          <button
            type="button"
            onClick={() => onSelect({ kind: 'all' })}
            className={pillClass(selection.kind === 'all')}
          >
            All time
          </button>
        )}
      </div>
      <div className="mt-5 flex items-center justify-between">
        <button
          type="button"
          onClick={onPrevYear}
          aria-label="Previous year"
          disabled={floorMonth !== null && (viewYear - 1) * 100 + 12 < floorMonth}
          className="text-ink-muted hover:text-ink -ml-2 flex size-9 items-center justify-center disabled:opacity-30"
        >
          <ChevronLeft size={16} />
        </button>
        <span className="font-mono text-[13px] font-medium">{viewYear}</span>
        <button
          type="button"
          onClick={onNextYear}
          aria-label="Next year"
          className="text-ink-muted hover:text-ink -mr-2 flex size-9 items-center justify-center"
        >
          <ChevronRight size={16} />
        </button>
      </div>
      <div className="mt-2.5 grid grid-cols-4 gap-1.5">
        {Array.from({ length: 12 }, (_, i) => viewYear * 100 + i + 1).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => onSelect({ kind: 'month', month: m })}
            disabled={beforeFloor(m)}
            className={cn(
              'rounded-[10px] py-2.5 text-[13px] font-medium disabled:cursor-not-allowed disabled:opacity-35',
              m === selectedMonth ? 'bg-iris text-paper-raised' : 'text-ink hover:bg-paper',
            )}
          >
            {monthShort((m % 100) - 1)}
          </button>
        ))}
      </div>
      {floorMonth !== null && (
        <p className="text-ink-muted mt-3 text-[12px]">
          Older months are part of Plus.{' '}
          <Link href="/upgrade" className="text-iris font-medium">
            Upgrade
          </Link>
        </p>
      )}
      {allowCustom && (
        <form
          className="border-line mt-5 border-t pt-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (customInvalid) return;
            onSelect({
              kind: 'custom',
              from: customDraft.from || null,
              to: customDraft.to || null,
            });
          }}
        >
          <Label htmlFor={`${idPrefix}-from`}>Custom range</Label>
          {/* stacked: two native date inputs don't fit side by side in the
              280px popover */}
          <div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-2">
            <span aria-hidden className="text-ink-muted text-xs">
              From
            </span>
            <Input
              id={`${idPrefix}-from`}
              aria-label="From"
              type="date"
              min={floorDate}
              value={customDraft.from}
              onChange={(e) => onCustomDraftChange({ ...customDraft, from: e.target.value })}
              className="w-full min-w-0"
            />
            <span aria-hidden className="text-ink-muted text-xs">
              To
            </span>
            <Input
              id={`${idPrefix}-to`}
              aria-label="To"
              type="date"
              min={floorDate}
              value={customDraft.to}
              onChange={(e) => onCustomDraftChange({ ...customDraft, to: e.target.value })}
              className="w-full min-w-0"
            />
          </div>
          <Button type="submit" disabled={customInvalid} className="mt-3 w-full py-2">
            Apply range
          </Button>
        </form>
      )}
    </>
  );
};

/**
 * The one period control every screen uses: a pill that opens presets + a
 * 12-month grid, anchored below the pill at lg and in a `BottomSheet` below
 * it. `allowCustom` adds "All time" and a custom date range, for the screens
 * whose data isn't calendar-month shaped (Transactions, Categorize).
 *
 * The sheet is rendered *inside* the ref-wrapped div on purpose: the
 * outside-click effect below closes on any mousedown outside that ref, so a
 * sibling/portal sheet would close itself on its own first tap. `fixed`
 * positioning is unaffected by the nesting.
 */
export const PeriodSelector = ({
  selection,
  onSelect,
  allowCustom = false,
}: {
  selection: PeriodSelection;
  onSelect: (selection: PeriodSelection) => void;
  allowCustom?: boolean;
}): React.ReactElement => {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const now = currentMonth();
  const { historyFloorMonth } = usePlan();
  const anchorMonth =
    selection.kind === 'month'
      ? selection.month
      : selection.kind === 'custom' && selection.from
        ? Number(selection.from.slice(0, 4)) * 100 + Number(selection.from.slice(5, 7))
        : now;
  const year = Math.floor(anchorMonth / 100);
  // Independent of the selected month's year, so ‹ › can browse years that
  // have no selection in them yet without changing what's actually applied.
  const [viewYear, setViewYear] = useState(year);
  const [customDraft, setCustomDraft] = useState({ from: '', to: '' });

  const openPicker = (): void => {
    setViewYear(year);
    const range = rangeFromSelection(selection);
    setCustomDraft({ from: range.from ?? '', to: range.to ?? '' });
    setOpen(true);
  };

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', onClick);
    return () => window.removeEventListener('mousedown', onClick);
  }, [open]);

  const close = useCallback((): void => setOpen(false), []);

  const select = (next: PeriodSelection): void => {
    setOpen(false);
    onSelect(next);
  };

  const body = (
    <PeriodPickerBody
      selection={selection}
      now={now}
      viewYear={viewYear}
      onPrevYear={() => setViewYear((y) => y - 1)}
      onNextYear={() => setViewYear((y) => y + 1)}
      onSelect={select}
      allowCustom={allowCustom}
      customDraft={customDraft}
      onCustomDraftChange={setCustomDraft}
      floorMonth={historyFloorMonth}
    />
  );

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => (open ? setOpen(false) : openPicker())}
        className="border-line bg-paper-raised text-ink flex items-center gap-2 rounded-full border px-3.5 py-2 text-[13px] font-medium whitespace-nowrap"
      >
        <Calendar size={14} />
        {periodSelectionLabel(selection)}
        <ChevronDown size={13} className="text-ink-muted" />
      </button>
      {open && (
        <div className="hidden lg:block">
          <div className="border-line bg-paper-raised absolute top-full left-0 z-20 mt-3 w-[280px] rounded-2xl border p-5 shadow-[0_18px_48px_rgba(0,0,0,.18)]">
            {body}
          </div>
        </div>
      )}
      <div className="lg:hidden">
        <BottomSheet open={open} onClose={close} title="Pick a period">
          {body}
        </BottomSheet>
      </div>
    </div>
  );
};

/**
 * Month-only selector backed by `?month=` (Overview, Budgets, Trends). Other
 * params survive a month change (Trends' `range`), except Overview's `day`,
 * which belongs to the month being left. The pick is also stored in the
 * shared period cookie, so the other screens open on it; a `month` arriving
 * in the URL (a link, back/forward) is stored the same way.
 */
export const PeriodPopover = ({
  month,
  basePath = '/dashboard',
}: {
  month: number;
  basePath?: string;
}): React.ReactElement => {
  const router = useRouter();
  const searchParams = useSearchParams();
  const urlMonth = searchParams.get('month');

  useEffect(() => {
    // Only an explicit URL month is stored: a month derived from a stored
    // custom range must not overwrite that range.
    if (urlMonth) writePeriodCookie({ kind: 'month', month });
  }, [urlMonth, month]);

  const onSelect = (next: PeriodSelection): void => {
    if (next.kind !== 'month') return;
    writePeriodCookie(next);
    const params = new URLSearchParams(searchParams.toString());
    params.delete('day');
    // Always explicit, even for the current month: a bare URL now means
    // "whatever was picked last", not "this month".
    params.set('month', String(next.month));
    router.push(`${basePath}?${params.toString()}`);
  };

  return <PeriodSelector selection={{ kind: 'month', month }} onSelect={onSelect} />;
};

/**
 * Month, all-time or custom-range selector backed by `?from=&to=` on the
 * current path (Transactions, Categorize). Every other param is kept, so it
 * composes with the Transactions filters rather than resetting them.
 *
 * `shallow` updates the URL without a server round trip, for a screen that
 * filters on the client (Transactions). `fallback` is what the screen is
 * showing when the URL has no range (the stored selection, on Categorize).
 */
export const DateRangePopover = ({
  shallow = false,
  fallback,
}: {
  shallow?: boolean;
  fallback?: DateRange;
}): React.ReactElement => {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const urlFrom = parseDateParam(searchParams.get('from'));
  const urlTo = parseDateParam(searchParams.get('to'));
  const hasUrlRange = !!(urlFrom || urlTo);
  const selection = selectionFromRange(
    hasUrlRange ? { from: urlFrom, to: urlTo } : (fallback ?? { from: null, to: null }),
  );

  useEffect(() => {
    // A range that arrives in the URL (a budget or trends drill-down, the
    // statement picker) becomes the shared selection too.
    if (hasUrlRange) writePeriodCookie(selectionFromRange({ from: urlFrom, to: urlTo }));
  }, [hasUrlRange, urlFrom, urlTo]);

  const onSelect = (next: PeriodSelection): void => {
    writePeriodCookie(next);
    const { from, to } = rangeFromSelection(next);
    const params = new URLSearchParams(searchParams.toString());
    if (from) params.set('from', from);
    else params.delete('from');
    if (to) params.set('to', to);
    else params.delete('to');
    const query = params.toString();
    const href = query ? `${pathname}?${query}` : pathname;
    if (shallow) window.history.replaceState(null, '', href);
    // Picking "All time" over a stored range leaves the URL unchanged (both
    // are bare), so only the cookie moved: re-render to pick it up.
    else if (href === `${pathname}${searchParams.size ? `?${searchParams}` : ''}`) router.refresh();
    else router.replace(href, { scroll: false });
  };

  return <PeriodSelector selection={selection} onSelect={onSelect} allowCustom />;
};
