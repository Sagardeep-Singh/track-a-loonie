'use client';

import { useStoredBudgetMode } from '@/lib/budget-mode-cookie';

const pulse = 'bg-paper-sunk [animation:om-pulse_1.4s_ease-in-out_infinite]';
const ringPulse = 'border-paper-sunk rounded-full [animation:om-pulse_1.4s_ease-in-out_infinite]';
const card = 'border-line bg-paper-raised border';

/** the savings goals line both modes show under the header */
const ShortcutPlaceholder = (): React.ReactElement => (
  <div className={`${card} mt-4 flex items-center gap-3 rounded-[14px] px-4 py-3`}>
    <div className={`size-[18px] rounded-full ${pulse}`} />
    <div className={`h-[11px] w-64 max-w-full rounded-md ${pulse}`} />
  </div>
);

/** limits mode: the all-budgets total, then budget cards with rings */
const LimitsBudgetsSkeleton = (): React.ReactElement => (
  <div data-testid="budgets-skeleton-limits">
    <ShortcutPlaceholder />
    <div className={`${card} mt-6.5 rounded-[18px] p-5.5`}>
      <div className={`h-[11px] w-36 rounded-md ${pulse}`} />
      <div className={`mt-3 h-[22px] w-56 max-w-full rounded-md ${pulse}`} />
      <div className={`mt-2.5 h-[11px] w-32 rounded-md ${pulse}`} />
      <div className={`mt-3 h-1.75 w-full rounded-full ${pulse}`} />
    </div>
    <div className="mt-4.5 grid grid-cols-1 gap-4 lg:grid-cols-2">
      {Array.from({ length: 4 }).map((_, i) => (
        <div
          key={i}
          className={`${card} flex items-center gap-4 rounded-2xl p-4.5 sm:gap-5.5 sm:p-5.5`}
        >
          <div className={`size-[84px] shrink-0 border-8 ${ringPulse}`} />
          <div className="min-w-0 flex-1">
            <div className={`h-[13px] w-24 rounded-md ${pulse}`} />
            <div className={`mt-2.5 h-[18px] w-32 rounded-md ${pulse}`} />
            <div className={`mt-2.5 h-[11px] w-28 rounded-md ${pulse}`} />
          </div>
        </div>
      ))}
    </div>
  </div>
);

/** zero-based: Ready to Assign, then the category table with mini rings */
const ZbbBudgetsSkeleton = (): React.ReactElement => (
  <div data-testid="budgets-skeleton-zbb">
    <ShortcutPlaceholder />
    <div className={`${card} mt-6.5 rounded-[18px] p-5.5`}>
      <div className={`h-[11px] w-28 rounded-md ${pulse}`} />
      <div className={`mt-3 h-[28px] w-40 rounded-md ${pulse}`} />
      <div className={`mt-3 h-[11px] w-60 max-w-full rounded-md ${pulse}`} />
      <div className={`mt-4 h-9 w-44 rounded-full ${pulse}`} />
    </div>
    <div className={`${card} mt-4.5 overflow-hidden rounded-2xl`}>
      <div className="border-line border-b px-5 py-3">
        <div className={`h-[10px] w-20 rounded-md ${pulse}`} />
      </div>
      {Array.from({ length: 5 }).map((_, i) => (
        <div
          key={i}
          className="border-line flex items-center gap-3 border-b px-5 py-3 last:border-b-0"
        >
          <div className={`size-9 shrink-0 border-4 ${ringPulse}`} />
          <div className="min-w-0 flex-1">
            <div className={`h-[13px] w-28 rounded-md ${pulse}`} />
            <div className={`mt-1.5 h-[10px] w-24 rounded-md ${pulse}`} />
          </div>
          <div className={`h-9 w-24 rounded-lg sm:w-36 ${pulse}`} />
          <div className={`hidden h-[13px] w-16 rounded-md sm:block ${pulse}`} />
          <div className={`hidden h-6 w-16 rounded-full sm:block ${pulse}`} />
        </div>
      ))}
    </div>
  </div>
);

export const BudgetsSkeleton = (): React.ReactElement =>
  useStoredBudgetMode() === 'ZERO_BASED' ? <ZbbBudgetsSkeleton /> : <LimitsBudgetsSkeleton />;
