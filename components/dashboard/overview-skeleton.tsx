'use client';

import { useStoredBudgetMode } from '@/lib/budget-mode-cookie';

const pulse = 'bg-paper-sunk [animation:om-pulse_1.4s_ease-in-out_infinite]';
const ringPulse = 'border-paper-sunk rounded-full [animation:om-pulse_1.4s_ease-in-out_infinite]';
const card = 'border-line bg-paper-raised rounded-[18px] border';

const RingPlaceholder = (): React.ReactElement => (
  <div className="flex min-w-0 flex-col items-center gap-2.5">
    <div
      className={`h-[66px] w-[66px] border-[7px] lg:h-[88px] lg:w-[88px] lg:border-[9px] ${ringPulse}`}
    />
    <div className={`h-2.5 w-16 rounded-md ${pulse}`} />
  </div>
);

/** limits mode: the spending ring hero, then a row of budget rings */
const LimitsOverviewSkeleton = (): React.ReactElement => (
  <div
    data-testid="overview-skeleton-limits"
    className="mt-6.5 grid grid-cols-1 items-start gap-5 lg:grid-cols-[1.5fr_1fr]"
  >
    <div className="flex flex-col gap-5">
      <div className={`${card} flex flex-col gap-5 p-6.5 lg:flex-row lg:items-center lg:gap-7.5`}>
        <div
          className={`h-[132px] w-[132px] shrink-0 border-[12px] lg:h-[152px] lg:w-[152px] lg:border-[14px] ${ringPulse}`}
        />
        <div className="flex-1">
          <div className={`h-[11px] w-[110px] rounded-md ${pulse}`} />
          <div className={`mt-3.5 h-[34px] w-full max-w-[230px] rounded-lg ${pulse}`} />
          <div className={`mt-4 h-[11px] w-full max-w-[180px] rounded-md ${pulse}`} />
        </div>
      </div>
      <div className={`${card} grid grid-cols-4 gap-2.5 p-6.5`}>
        {Array.from({ length: 4 }).map((_, i) => (
          <RingPlaceholder key={i} />
        ))}
      </div>
      <div className={`${card} h-[150px] ${pulse}`} />
    </div>
    <div className="flex flex-col gap-5">
      <div className={`${card} h-[280px] ${pulse}`} />
      <div className={`${card} h-[150px] ${pulse}`} />
    </div>
  </div>
);

/**
 * zero-based: the Ready to Assign card with its four figures, two rows of
 * category rings (desktop) or category bars (mobile), the suggestions list,
 * and where the money is on the side
 */
const ZbbOverviewSkeleton = (): React.ReactElement => (
  <div
    data-testid="overview-skeleton-zbb"
    className="mt-6.5 grid grid-cols-1 items-start gap-5 lg:grid-cols-[1.5fr_1fr]"
  >
    <div className="flex flex-col gap-5">
      <div className={`${card} p-6.5`}>
        <div className={`h-[11px] w-[110px] rounded-md ${pulse}`} />
        <div className={`mt-3.5 h-[40px] w-full max-w-[240px] rounded-lg ${pulse}`} />
        <div className={`mt-3.5 h-[11px] w-full max-w-[320px] rounded-md ${pulse}`} />
        <div className="border-line mt-5 grid grid-cols-2 gap-4 border-t pt-4 sm:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i}>
              <div className={`h-[10px] w-14 rounded-md ${pulse}`} />
              <div className={`mt-2 h-[18px] w-20 rounded-md ${pulse}`} />
            </div>
          ))}
        </div>
      </div>
      <div className={`${card} hidden grid-cols-4 gap-x-2.5 gap-y-4 p-6.5 lg:grid`}>
        {Array.from({ length: 8 }).map((_, i) => (
          <RingPlaceholder key={i} />
        ))}
      </div>
      <div className={`${card} flex flex-col gap-4 p-5.5 lg:hidden`}>
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i}>
            <div className={`h-[11px] w-32 rounded-md ${pulse}`} />
            <div className={`mt-2 h-1.5 w-full rounded-full ${pulse}`} />
          </div>
        ))}
      </div>
      <div className={`${card} flex flex-col gap-4 p-5.5`}>
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i}>
            <div className={`h-[13px] w-56 max-w-full rounded-md ${pulse}`} />
            <div className={`mt-2 h-[11px] w-full max-w-[380px] rounded-md ${pulse}`} />
          </div>
        ))}
      </div>
    </div>
    <div className="flex flex-col gap-5">
      <div className={`${card} p-5.5`}>
        <div className={`h-[13px] w-36 rounded-md ${pulse}`} />
        <div className={`mt-4 h-2.5 w-full rounded-full ${pulse}`} />
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className={`mt-3.5 h-[11px] w-full rounded-md ${pulse}`} />
        ))}
      </div>
      <div className={`${card} h-[280px] ${pulse}`} />
    </div>
  </div>
);

export const OverviewSkeleton = (): React.ReactElement =>
  useStoredBudgetMode() === 'ZERO_BASED' ? <ZbbOverviewSkeleton /> : <LimitsOverviewSkeleton />;
