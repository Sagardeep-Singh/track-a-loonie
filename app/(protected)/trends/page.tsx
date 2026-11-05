import Link from 'next/link';
import { getServerAuthSession } from '@/lib/auth/session';
import { getSpendingTrends, type TrendsRange } from '@/lib/services/trends';
import { hasFeature } from '@/lib/services/entitlements';
import { UpgradePrompt } from '@/components/billing/upgrade-prompt';
import { ScreenHeader } from '@/components/nav/screen-header';
import { PeriodPopover } from '@/components/dashboard/period-popover';
import { RangePopover } from '@/components/trends/range-popover';
import { SpendingHeadline } from '@/components/trends/spending-headline';
import { SpendingLineChart } from '@/components/trends/spending-line-chart';
import { CategoryBreakdownBar } from '@/components/trends/category-breakdown-bar';
import { SpendingMovers } from '@/components/trends/spending-movers';
import { currentMonthNumber, daysElapsedInMonth } from '@/lib/format';
import { monthToRange, selectionMonth } from '@/lib/period-selection';
import { getStoredPeriod } from '@/lib/period-cookie';

const VALID_RANGES: TrendsRange[] = [3, 6, 12];

const DAY_MONTH_FORMAT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'UTC',
  month: 'short',
  day: 'numeric',
});
const DAY_MONTH_YEAR_FORMAT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'UTC',
  month: 'short',
  day: 'numeric',
  year: 'numeric',
});
const MONTH_NAME_FORMAT = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'long' });

const monthStartDate = (month: number): Date =>
  new Date(Date.UTC(Math.floor(month / 100), (month % 100) - 1, 1));

const parseRange = (value?: string): TrendsRange => {
  const n = Number(value);
  return VALID_RANGES.includes(n as TrendsRange) ? (n as TrendsRange) : 3;
};

const currentMonth = (): number => {
  const now = new Date();
  return now.getUTCFullYear() * 100 + (now.getUTCMonth() + 1);
};

const TrendsPage = async ({
  searchParams,
}: {
  searchParams: Promise<{ month?: string; range?: string }>;
}): Promise<React.ReactElement> => {
  const { month: monthParam, range: rangeParam } = await searchParams;
  const session = await getServerAuthSession();
  const userId = session!.user.id;
  if (!(await hasFeature(userId, 'trends'))) {
    return (
      <div className="animate-[fade-up_0.3s_ease-out]">
        <ScreenHeader title="Trends" description="How your spending moves across months." />
        <UpgradePrompt
          className="mt-6"
          title="Spending trends are part of Plus"
          description="See income and spending across 3, 6 or 12 months, which categories moved, and by how much."
        />
      </div>
    );
  }
  // No month in the URL: open on the period last picked on any screen.
  const month = monthParam
    ? Number(monthParam)
    : selectionMonth(await getStoredPeriod(), currentMonth());
  const range = parseRange(rangeParam);
  const data = await getSpendingTrends(userId, { month, range });

  const isEmpty = data.months.every((m) => m.income === 0 && m.expense === 0);

  const firstMonth = data.months[0]!.month;
  const lastMonth = data.months[data.months.length - 1]!.month;
  const lastMonthInProgress = lastMonth === currentMonthNumber();
  const rangeStartLabel = DAY_MONTH_FORMAT.format(monthStartDate(firstMonth));
  const rangeEndDate = lastMonthInProgress
    ? new Date()
    : new Date(
        Date.UTC(Math.floor(lastMonth / 100), (lastMonth % 100) - 1, daysElapsedInMonth(lastMonth)),
      );
  const rangeEndLabel = DAY_MONTH_YEAR_FORMAT.format(rangeEndDate);
  const subtitle = lastMonthInProgress
    ? `${rangeStartLabel} – ${rangeEndLabel} · ${MONTH_NAME_FORMAT.format(monthStartDate(lastMonth))} still in progress`
    : `${rangeStartLabel} – ${rangeEndLabel}`;

  return (
    <div className="animate-[fade-up_0.3s_ease-out]">
      <ScreenHeader
        title="Trends"
        description={subtitle}
        periodSlot={
          <div className="hidden items-center gap-2 lg:flex">
            <PeriodPopover month={month} basePath="/trends" />
            <RangePopover range={range} month={month} />
          </div>
        }
      />

      <div className="mt-3.5 lg:hidden">
        <div className="flex items-center gap-2">
          <PeriodPopover month={month} basePath="/trends" />
        </div>
        <div className="bg-paper-sunk mt-3 flex gap-1 rounded-full p-1">
          {VALID_RANGES.map((r) => (
            <Link
              key={r}
              href={`/trends?${new URLSearchParams({ ...(month ? { month: String(month) } : {}), range: String(r) }).toString()}`}
              className={
                r === range
                  ? 'bg-paper-raised text-ink flex-1 rounded-full py-2.5 text-center text-[13.5px] font-semibold shadow-sm'
                  : 'text-ink-muted flex-1 rounded-full py-2.5 text-center text-[13.5px] font-medium'
              }
            >
              {r} months
            </Link>
          ))}
        </div>
      </div>

      {isEmpty ? (
        <div className="border-line bg-paper-raised mt-6.5 rounded-[20px] border border-dashed p-18 text-center">
          <div className="border-paper-sunk mx-auto h-24 w-24 rounded-full border-[10px]" />
          <h2 className="font-display mt-6.5 text-xl font-semibold">Not enough history yet</h2>
          <p className="text-ink-muted mx-auto mt-2 max-w-[420px] text-sm leading-relaxed text-pretty">
            Trends need a few months of transactions to chart. Come back once you&apos;ve logged
            some spending, or try a wider range.
          </p>
        </div>
      ) : (
        <div className="mt-6.5 grid grid-cols-1 items-start gap-5 lg:grid-cols-[1.5fr_1fr]">
          <div className="flex min-w-0 flex-col gap-5">
            <div className="border-line bg-paper-raised rounded-[18px] border p-5.5">
              <div className="mb-4.5 flex items-baseline justify-between">
                <h2 className="font-display text-base font-semibold">Income vs. expense</h2>
              </div>
              <SpendingLineChart months={data.months} />
            </div>

            <div className="border-line bg-paper-raised rounded-[18px] border p-5.5">
              <div className="mb-4.5 flex items-baseline justify-between">
                <h2 className="font-display text-base font-semibold">By category</h2>
              </div>
              <CategoryBreakdownBar
                months={data.months}
                categories={data.categories}
                breakdown={data.categoryBreakdown}
                uncategorizedCount={data.uncategorizedCount}
              />
            </div>
          </div>

          <div className="flex min-w-0 flex-col gap-5">
            <div className="border-line bg-paper-raised rounded-[18px] border p-5.5">
              <SpendingHeadline headline={data.headline} />
            </div>

            <div className="border-line bg-paper-raised rounded-[18px] border p-5.5">
              <div className="mb-4 flex items-baseline justify-between">
                <h2 className="font-display text-base font-semibold">Notable movers</h2>
                <span className="text-ink-muted text-xs">
                  {data.headline.priorRangeLabel} → {data.headline.currentRangeLabel}
                </span>
              </div>
              <SpendingMovers
                movers={data.movers}
                from={monthToRange(firstMonth).from}
                to={monthToRange(lastMonth).to}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default TrendsPage;
