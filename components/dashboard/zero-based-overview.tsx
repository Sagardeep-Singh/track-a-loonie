import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import {
  overviewCategoryHref,
  overviewExpenseHref,
  overviewIncomeHref,
} from '@/lib/dashboard/drilldown';
import { cn } from '@/lib/cn';
import type { CategoryHealth, InsightTone, Suggestion } from '@/lib/budgets/zero-based-insights';
import type { FrontendZbbOverview } from '@/lib/services/zeroBased';

/**
 * The zero-based Overview cards. They replace the spending-limits hero and
 * budget rings when the user is in zero-based mode; everything else on the
 * Overview (cash flow, spending pie, by-day bars, day panel) stays as is.
 * Server components only: every action is a link.
 */

const MONEY = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const money = (value: string | number): string => MONEY.format(Number(value));
const moneyCents = (cents: number): string => MONEY.format(cents / 100);

const TONE_DOT: Record<InsightTone, string> = {
  rose: 'bg-rose',
  iris: 'bg-iris',
  sky: 'bg-sky',
  neutral: 'bg-ink-muted',
};

// same validated categorical palette as the spending pie, fixed order
const SLICE_COLORS = [
  'var(--chart-1)',
  'var(--chart-2)',
  'var(--chart-3)',
  'var(--chart-4)',
  'var(--chart-5)',
  'var(--chart-6)',
];
const OTHER_COLOR = 'var(--ink-muted)';
const READY_COLOR = 'var(--line)';

const card = 'border-line bg-paper-raised rounded-[18px] border p-4.5 lg:p-5.5';

const actionHref = (action: NonNullable<Suggestion['action']>, month: number): string => {
  if (action.kind === 'categorize') return '/categorize';
  if (action.kind === 'category') return overviewCategoryHref(month, [action.categoryId]);
  return `/budgets?month=${action.month}`;
};

const readyState = (
  ready: number,
): { label: string; detail: string; tone: string; dot: string } => {
  if (ready < 0) {
    return {
      label: 'Over-assigned',
      detail: 'More is assigned than you have. Take some back to get to $0.',
      tone: 'text-rose',
      dot: 'bg-rose',
    };
  }
  if (ready > 0) {
    return {
      label: 'Ready to assign',
      detail: 'Give these dollars a job: a bill, a goal or next month.',
      tone: 'text-iris',
      dot: 'bg-iris',
    };
  }
  return {
    label: 'All assigned',
    detail: 'Every dollar you have has a job.',
    tone: 'text-sky',
    dot: 'bg-sky',
  };
};

export const ZbbHeroCard = ({ data }: { data: FrontendZbbOverview }): React.ReactElement => {
  const ready = Number(data.readyToAssign);
  const state = readyState(ready);
  const overspent = Number(data.overspent);

  const stats: { label: string; value: string; href?: string; tone?: string }[] = [
    {
      label: 'Income',
      value: data.incomeThisMonth,
      href: overviewIncomeHref(data.month),
      tone: 'text-sky',
    },
    { label: 'Assigned', value: data.assignedThisMonth, href: `/budgets?month=${data.month}` },
    {
      label: 'Spent',
      value: data.spentThisMonth,
      href: overviewExpenseHref(data.month),
      tone: 'text-rose',
    },
    { label: 'Available', value: data.availableTotal, href: `/budgets?month=${data.month}` },
  ];

  return (
    <div className={card} data-testid="zbb-hero">
      <div className="flex items-center gap-1.5">
        <span className={cn('size-1.5 rounded-full', state.dot)} />
        <span className={cn('text-[11px] font-semibold tracking-[0.06em] uppercase', state.tone)}>
          {state.label}
        </span>
      </div>
      <div
        className={cn(
          'mt-2 font-mono text-[34px] leading-none font-medium tracking-[-0.03em] tabular-nums lg:text-[40px]',
          ready < 0 && 'text-rose',
        )}
      >
        {money(ready)}
      </div>
      <p className="text-ink-muted mt-2 text-[13px] leading-snug">
        {state.detail}
        {overspent > 0 && (
          <>
            {' '}
            <span className="text-rose">{money(overspent)} is overspent.</span>
          </>
        )}
      </p>
      <div className="border-line mt-4 grid grid-cols-2 gap-x-5 gap-y-3 border-t pt-4 sm:grid-cols-4">
        {stats.map((s) => (
          <Link key={s.label} href={s.href ?? '#'} className="group min-w-0">
            <div className="text-ink-muted text-[10.5px] font-semibold tracking-[0.08em] uppercase">
              {s.label}
            </div>
            <div
              className={cn(
                'mt-1 truncate font-mono text-[16px] tabular-nums group-hover:underline',
                s.tone,
                Number(s.value) < 0 && 'text-rose',
              )}
            >
              {money(s.value)}
            </div>
          </Link>
        ))}
      </div>
      {Number(data.nextMonthAssigned) > 0 && (
        <p className="text-ink-muted mt-3.5 text-[12.5px]">
          <span className="text-ink font-mono">{money(data.nextMonthAssigned)}</span> already set
          aside for next month.
        </p>
      )}
    </div>
  );
};

export const ZbbSuggestionsCard = ({ data }: { data: FrontendZbbOverview }): React.ReactElement => (
  <div className={card} data-testid="zbb-suggestions">
    <h2 className="font-display text-base font-semibold">What to do next</h2>
    <ul className="mt-3 flex flex-col">
      {data.suggestions.map((s) => (
        <li
          key={s.id}
          data-testid={`zbb-suggestion-${s.id}`}
          className="border-line flex gap-3 border-t py-3 first:border-t-0 first:pt-1"
        >
          <span className={cn('mt-1.5 size-2 shrink-0 rounded-full', TONE_DOT[s.tone])} />
          <div className="min-w-0 flex-1">
            <div className="text-[14px] font-medium">{s.title}</div>
            <p className="text-ink-muted mt-0.5 text-[12.5px] leading-snug">{s.detail}</p>
            {s.action && (
              <Link
                href={actionHref(s.action, data.month)}
                className="text-iris mt-1.5 inline-flex items-center gap-1 text-[12.5px] font-semibold"
              >
                {s.action.label}
                <ArrowRight size={13} />
              </Link>
            )}
          </div>
        </li>
      ))}
    </ul>
  </div>
);

export const ZbbAllocationCard = ({
  data,
}: {
  data: FrontendZbbOverview;
}): React.ReactElement | null => {
  const total = data.allocation.reduce((sum, s) => sum + s.cents, 0);
  if (total <= 0) return null;

  let colorIndex = 0;
  const slices = data.allocation.map((s) => {
    const color =
      s.kind === 'ready'
        ? READY_COLOR
        : s.kind === 'other'
          ? OTHER_COLOR
          : SLICE_COLORS[colorIndex++ % SLICE_COLORS.length];
    return { ...s, color, share: s.cents / total };
  });

  return (
    <div className={card} data-testid="zbb-allocation">
      <div className="flex items-baseline justify-between gap-2.5">
        <h2 className="font-display text-base font-semibold">Where your money is</h2>
        <span className="text-ink-muted font-mono text-xs">{moneyCents(total)}</span>
      </div>
      <div
        className="bg-paper-sunk mt-3.5 flex h-3 gap-0.5 overflow-hidden rounded-full"
        role="img"
        aria-label={slices.map((s) => `${s.label} ${moneyCents(s.cents)}`).join(', ')}
      >
        {slices.map((s) => (
          <span
            key={s.categoryId ?? s.kind}
            className="block h-full"
            style={{ width: `${Math.max(s.share * 100, 1)}%`, background: s.color }}
          />
        ))}
      </div>
      <ul className="mt-3.5 flex flex-col gap-2">
        {slices.map((s) => (
          <li key={s.categoryId ?? s.kind} className="flex items-center gap-2.5 text-[13px]">
            <span className="size-2.5 shrink-0 rounded-[3px]" style={{ background: s.color }} />
            <span className="min-w-0 flex-1 truncate">{s.label}</span>
            <span className="text-ink-muted font-mono text-[12px] tabular-nums">
              {Math.round(s.share * 100)}%
            </span>
            <span className="w-24 text-right font-mono text-[12.5px] tabular-nums">
              {moneyCents(s.cents)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
};

const STATUS_LABEL: Record<CategoryHealth['status'], string> = {
  overspent: 'Overspent',
  'at-risk': 'Running low',
  underfunded: 'Below target',
  funded: 'On track',
};

const STATUS_PILL: Record<CategoryHealth['status'], string> = {
  overspent: 'bg-rose-soft text-rose',
  'at-risk': 'bg-iris-soft text-iris',
  underfunded: 'bg-paper-sunk text-ink-muted',
  funded: 'bg-sky-soft text-sky',
};

const HEALTH_ROWS = 6;

export const ZbbHealthCard = ({
  data,
  monthShortLabel,
}: {
  data: FrontendZbbOverview;
  monthShortLabel: string;
}): React.ReactElement => {
  const rows = data.health.slice(0, HEALTH_ROWS);
  return (
    <div className={card} data-testid="zbb-health">
      <div className="mb-3.5 flex items-baseline justify-between gap-2.5">
        <h2 className="font-display text-base font-semibold">Categories</h2>
        <Link href={`/budgets?month=${data.month}`} className="text-iris text-[12px] font-medium">
          {data.health.length > HEALTH_ROWS ? `See all ${data.health.length}` : 'Open budget'}
        </Link>
      </div>
      {rows.length === 0 ? (
        <p className="text-ink-muted text-sm">
          Nothing assigned yet this month.{' '}
          <Link href={`/budgets?month=${data.month}`} className="text-iris font-medium">
            Start assigning
          </Link>
          .
        </p>
      ) : (
        <ul className="flex flex-col gap-3.5">
          {rows.map((h) => {
            const used =
              h.fundedCents > 0
                ? Math.min(h.activityCents / h.fundedCents, 1)
                : h.activityCents > 0
                  ? 1
                  : 0;
            return (
              <li key={h.categoryId} data-testid={`zbb-health-${h.categoryName}`}>
                <Link href={overviewCategoryHref(data.month, [h.categoryId])} className="block">
                  <div className="flex items-center justify-between gap-2 text-[13px]">
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="truncate font-medium">{h.categoryName}</span>
                      <span
                        className={cn(
                          'shrink-0 rounded-full px-2 py-px text-[10.5px] font-semibold',
                          STATUS_PILL[h.status],
                        )}
                      >
                        {h.status === 'at-risk' && h.runOutDay !== null
                          ? `Empty ~${monthShortLabel} ${h.runOutDay}`
                          : STATUS_LABEL[h.status]}
                      </span>
                    </span>
                    <span
                      className={cn(
                        'shrink-0 font-mono tabular-nums',
                        h.availableCents < 0 ? 'text-rose' : 'text-ink',
                      )}
                    >
                      {moneyCents(h.availableCents)}
                    </span>
                  </div>
                  <div className="bg-paper-sunk mt-1.5 flex h-1.5 overflow-hidden rounded-full">
                    <span
                      className={cn(
                        'block',
                        h.status === 'overspent'
                          ? 'bg-rose'
                          : h.status === 'at-risk'
                            ? 'bg-iris'
                            : 'bg-sky',
                      )}
                      style={{ width: `${Math.round(used * 100)}%` }}
                    />
                  </div>
                  <div className="text-ink-muted mt-1 font-mono text-[11px] tabular-nums">
                    {moneyCents(h.activityCents)} spent of {moneyCents(h.fundedCents)}
                    {h.targetShortfallCents > 0 &&
                      ` · ${moneyCents(h.targetShortfallCents)} below target`}
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
};
