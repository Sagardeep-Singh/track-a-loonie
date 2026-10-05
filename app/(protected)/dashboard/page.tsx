import Link from 'next/link';
import { Plus } from 'lucide-react';
import { getServerAuthSession } from '@/lib/auth/session';
import { getOverviewData, type OverviewDayBar } from '@/lib/services/overview';
import { ScreenHeader } from '@/components/nav/screen-header';
import { AnimatedMoney } from '@/components/ui/animated-money';
import { Ring } from '@/components/ui/ring';
import { PeriodPopover } from '@/components/dashboard/period-popover';
import { ExpensePie } from '@/components/dashboard/expense-pie';
import { DayPanel } from '@/components/dashboard/day-panel';
import { getByDayBars } from '@/lib/dashboard/day-bars';
import {
  overviewCategoryHref,
  overviewExpenseHref,
  overviewIncomeHref,
  overviewNetHref,
} from '@/lib/dashboard/drilldown';
import { cn } from '@/lib/cn';
import { getStoredPeriod } from '@/lib/period-cookie';
import { selectionMonth } from '@/lib/period-selection';

const money = (value: string): string =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Number(value));

const RANGE_MONTH = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short' });

const monthRangeLabel = (month: number): string => {
  const year = Math.floor(month / 100);
  const monthIndex = (month % 100) - 1;
  const daysInMonth = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
  const label = RANGE_MONTH.format(new Date(Date.UTC(year, monthIndex, 1)));
  return `${label} 1–${daysInMonth}, ${year}`;
};

const currentMonthNum = (): number => {
  const now = new Date();
  return now.getUTCFullYear() * 100 + (now.getUTCMonth() + 1);
};

const DashboardPage = async ({
  searchParams,
}: {
  searchParams: Promise<{ day?: string; month?: string }>;
}): Promise<React.ReactElement> => {
  const { day, month } = await searchParams;
  const session = await getServerAuthSession();
  const userId = session!.user.id;
  // No month in the URL: open on the period last picked on any screen.
  const storedMonth = month
    ? undefined
    : selectionMonth(await getStoredPeriod(), currentMonthNum());
  const data = await getOverviewData(userId, {
    day: day ? Number(day) : undefined,
    month: month ? Number(month) : storedMonth,
  });
  const {
    hero,
    budgetRings,
    expenseBreakdown,
    dayBars,
    selectedDay,
    triage,
    cycleCard,
    dailyPace,
  } = data;

  const dayHref = (d: number): string =>
    month ? `/dashboard?month=${month}&day=${d}` : `/dashboard?day=${d}`;

  const maxBar = Math.max(1, ...dayBars.flatMap((d) => [d.income, d.expense]));
  const barScale = (amount: number): number => Math.round((amount / maxBar) * 100);

  // Written once, rendered at two sizes: the desktop hero ring and its smaller
  // mobile twin (both stay in the DOM, visibility is CSS-only — there is no
  // reliable server-side viewport check).
  const heroRingLabel = (sizeClass: string): React.ReactElement => (
    <>
      <span className={cn('font-mono tabular-nums', sizeClass)}>
        {Math.round(Math.min(hero.usedFraction, 1) * 100)}%
      </span>
      <span className="text-ink-muted mt-0.5 text-[10px] tracking-[0.09em] uppercase">used</span>
    </>
  );

  const byDayBars = (
    bars: OverviewDayBar[],
    className: string,
    mode: 'week' | 'month',
  ): React.ReactElement => (
    <div className={className}>
      <div className="flex h-[120px] items-end gap-1">
        {bars.map((d) => {
          const isSelected = d.day === selectedDay.day;
          const isOverPace = Number(dailyPace) > 0 && d.expense > Number(dailyPace);
          return (
            <Link
              key={d.day}
              href={dayHref(d.day)}
              title={`Sep ${d.day} · in ${money(d.income.toFixed(2))} · out ${money(d.expense.toFixed(2))}`}
              className="flex h-full flex-1 flex-col justify-end gap-[3px]"
            >
              <span
                className="bg-sky block rounded-[3px]"
                style={{ height: `${barScale(d.income)}px` }}
              />
              <span
                className={cn(
                  'block rounded-[3px]',
                  isSelected ? 'bg-iris' : isOverPace ? 'bg-rose' : 'bg-line',
                )}
                style={{ height: `${barScale(d.expense)}px` }}
              />
            </Link>
          );
        })}
      </div>
      <div className="bg-line mt-2 h-px" />
      <div className="text-ink-muted mt-2 flex justify-between font-mono text-[11px]">
        {mode === 'month' ? (
          <>
            <span>Day 1</span>
            <span>Day {Math.round(data.daysInMonth / 2)}</span>
            <span>Day {data.daysInMonth}</span>
          </>
        ) : (
          <>
            <span>Day {bars[0]?.day ?? 1}</span>
            <span>Day {bars[bars.length - 1]?.day ?? 1}</span>
          </>
        )}
      </div>
    </div>
  );

  const isEmpty =
    budgetRings.length === 0 &&
    Number(hero.income) === 0 &&
    Number(hero.expense) === 0 &&
    !cycleCard;

  // With ?day= present, below lg the Day panel *is* the screen (per the plan's
  // "no new route" decision). The swap lives on new wrapper divs rather than
  // appended classes: `cn` is a plain join, so a `hidden` tacked onto an
  // existing className can lose to whatever display utility is already there.
  const dayFocus = day !== undefined;

  return (
    <div className="animate-[fade-up_0.3s_ease-out] pb-20 lg:pb-0">
      <div className={dayFocus ? 'hidden lg:block' : undefined}>
        <ScreenHeader
          title="Overview"
          description={
            <>
              <span className="hidden lg:inline">Here&rsquo;s where things stand this month.</span>
              <span className="lg:hidden">
                {data.month < currentMonthNum() ? 'Closed month' : 'Open month'} ·{' '}
                {monthRangeLabel(data.month)}
              </span>
            </>
          }
          periodSlot={<PeriodPopover month={data.month} />}
          actions={
            <>
              <Link
                href="/import"
                className="border-line text-ink hidden rounded-full border px-4 py-2 text-sm lg:inline-flex"
              >
                Import CSV
              </Link>
              <Link
                href="?overlay=add"
                className="bg-iris text-paper-raised hidden rounded-full px-4 py-2 text-sm font-semibold lg:inline-flex"
              >
                Add transaction
              </Link>
            </>
          }
        />

        {isEmpty ? (
          <div className="border-line bg-paper-raised mt-6.5 rounded-[20px] border border-dashed p-18 text-center">
            <div className="border-paper-sunk mx-auto h-24 w-24 rounded-full border-[10px]" />
            <h2 className="font-display mt-6.5 text-xl font-semibold">Nothing to chart yet</h2>
            <p className="text-ink-muted mx-auto mt-2 max-w-[420px] text-sm leading-relaxed text-pretty">
              Import a statement or add your first transaction. Track a Loonie builds budgets from
              the categories it finds, so the rings fill in as soon as there is data.
            </p>
            <div className="mt-6 flex justify-center gap-2.5">
              <Link
                href="/import"
                className="bg-iris text-paper-raised rounded-full px-5 py-2.5 text-sm font-semibold"
              >
                Import CSV
              </Link>
              <Link
                href="?overlay=add"
                className="border-line text-ink rounded-full border px-5 py-2.5 text-sm"
              >
                Add manually
              </Link>
            </div>
          </div>
        ) : (
          <div className="hidden items-start gap-5 lg:mt-6.5 lg:grid lg:grid-cols-[1.5fr_1fr]">
            <div className="flex min-w-0 flex-col gap-5">
              <div className="border-line bg-paper-raised rounded-[18px] border p-6.5">
                <div className="flex items-center gap-7.5">
                  <div className="shrink-0">
                    <Ring size="hero" fraction={hero.usedFraction}>
                      {heroRingLabel('text-[21px]')}
                    </Ring>
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-ink-muted text-[11px] font-semibold tracking-[0.08em] uppercase">
                      {hero.leftLabel}
                    </div>
                    <div className="mt-2 font-mono text-[40px] leading-none font-medium tracking-[-0.03em]">
                      {hero.hasBudget ? <AnimatedMoney value={Number(hero.leftAmount)} /> : '—'}
                    </div>
                    <div className="text-ink-muted mt-2 text-[13.5px]">
                      {hero.hasBudget ? (
                        <>
                          {hero.metaLine} ·{' '}
                          <span className="text-ink font-mono">{money(hero.paceAmount)}</span>{' '}
                          {hero.paceTail}
                        </>
                      ) : (
                        <>
                          {hero.metaLine} · {hero.paceTail}
                        </>
                      )}
                    </div>
                    <div className="border-line mt-4.5 flex flex-wrap gap-x-6.5 gap-y-3 border-t pt-4 lg:flex-nowrap">
                      <Link href={overviewIncomeHref(data.month)} className="group">
                        <div className="text-ink-muted text-[10.5px] font-semibold tracking-[0.08em] uppercase">
                          In
                        </div>
                        <div className="text-sky mt-1.5 font-mono text-lg tabular-nums group-hover:underline">
                          {money(hero.income)}
                        </div>
                      </Link>
                      <Link href={overviewExpenseHref(data.month)} className="group">
                        <div className="text-ink-muted text-[10.5px] font-semibold tracking-[0.08em] uppercase">
                          Out
                        </div>
                        <div className="text-rose mt-1.5 font-mono text-lg tabular-nums group-hover:underline">
                          {money(hero.expense)}
                        </div>
                      </Link>
                      <Link href={overviewNetHref(data.month)} className="group">
                        <div className="text-ink-muted text-[10.5px] font-semibold tracking-[0.08em] uppercase">
                          Net
                        </div>
                        <div className="mt-1.5 font-mono text-lg tabular-nums group-hover:underline">
                          {money(hero.net)}
                        </div>
                      </Link>
                    </div>
                  </div>
                </div>
                <div
                  className={cn(
                    'mt-5 rounded-xl px-4 py-2.5 text-[13px] leading-snug',
                    hero.paceTone === 'rose'
                      ? 'bg-rose-soft text-rose'
                      : hero.paceTone === 'sky'
                        ? 'bg-sky-soft text-sky'
                        : 'bg-paper-sunk text-ink-muted',
                  )}
                >
                  {hero.paceNote}
                </div>
              </div>

              <div className="border-line bg-paper-raised rounded-[18px] border p-5.5">
                <div className="mb-4.5 flex items-baseline justify-between">
                  <h2 className="font-display text-base font-semibold">Budgets</h2>
                  <span className="text-ink-muted text-xs">share of each limit used</span>
                </div>
                {budgetRings.length === 0 ? (
                  <p className="text-ink-muted text-sm">
                    No budgets set for this month yet.{' '}
                    <Link href="/budgets" className="text-iris font-medium">
                      Set one
                    </Link>
                    .
                  </p>
                ) : (
                  <div className="grid grid-cols-4 gap-2.5">
                    {budgetRings.map((r, index) => (
                      <Link
                        key={r.id}
                        style={{ '--i': index } as React.CSSProperties}
                        href={overviewCategoryHref(data.month, [r.categoryId])}
                        className="stagger-item hover:bg-paper flex flex-col items-center gap-2.5 rounded-xl py-1.5"
                      >
                        <Ring size="category" fraction={r.fraction}>
                          <span className="font-mono text-sm">{r.pctLabel}</span>
                        </Ring>
                        <div className="text-center text-[12.5px] leading-tight">
                          {r.categoryName}
                          <br />
                          <span
                            className={cn(
                              'font-mono text-xs',
                              r.over ? 'text-rose' : 'text-ink-muted',
                            )}
                          >
                            {money(r.left.replace('Over by ', ''))}
                            {r.over && ' over'}
                          </span>
                        </div>
                      </Link>
                    ))}
                  </div>
                )}
              </div>

              <div className="border-line bg-paper-raised rounded-[18px] border p-5.5">
                <div className="mb-4.5 flex items-baseline justify-between">
                  <h2 className="font-display text-base font-semibold">Spending by category</h2>
                  <span className="text-ink-muted text-xs">all expenses this month</span>
                </div>
                <ExpensePie slices={expenseBreakdown} total={hero.expense} month={data.month} />
              </div>

              <div className="border-line bg-paper-raised rounded-[18px] border p-5.5">
                <div className="mb-4 flex items-baseline justify-between">
                  <h2 className="font-display text-base font-semibold">By day</h2>
                  <span className="text-ink-muted font-mono text-xs">
                    click a day to inspect it
                  </span>
                </div>
                {byDayBars(
                  getByDayBars(dayBars, 'month', selectedDay.day, data.daysInMonth),
                  'block',
                  'month',
                )}
              </div>
            </div>

            <div className="flex min-w-0 flex-col gap-5">
              <div data-testid="day-panel-desktop">
                <DayPanel
                  month={data.month}
                  selectedDay={selectedDay}
                  daysInMonth={data.daysInMonth}
                  dayHref={dayHref}
                />
              </div>

              {triage.total > 0 && (
                <div className="border-iris bg-iris-soft rounded-[18px] border p-5.5">
                  <div className="flex items-baseline justify-between">
                    <h2 className="font-display text-base font-semibold">
                      {triage.total} need{triage.total === 1 ? 's' : ''} a category
                    </h2>
                    <Link href="/categorize" className="text-iris text-[13px] font-semibold">
                      Open queue →
                    </Link>
                  </div>
                  <p className="text-ink/80 mt-2 text-[13px] leading-snug">
                    Rules matched {triage.matched} of them. Confirm in a batch, and Track a Loonie
                    will write the rule for next time.
                  </p>
                  {/* One segment per item to triage: at mobile width the inter-segment
                    gaps alone can exceed the card, so they tighten and clip. */}
                  <div className="mt-4 flex gap-0.5 overflow-hidden lg:gap-1">
                    {Array.from({ length: triage.total }).map((_, i) => (
                      <span
                        key={i}
                        className={cn(
                          'h-1.5 flex-1 rounded-full',
                          i < triage.matched ? 'bg-iris' : 'bg-paper-raised',
                        )}
                      />
                    ))}
                  </div>
                </div>
              )}

              {cycleCard && (
                <div className="border-line bg-paper-raised rounded-[18px] border p-5.5">
                  <div className="flex items-baseline justify-between">
                    <h2 className="font-display text-base font-semibold">
                      {cycleCard.accountName}
                    </h2>
                    <span className="text-ink-muted text-xs">
                      closes in {cycleCard.closesInDays} days
                    </span>
                  </div>
                  <div className="mt-2.5 font-mono text-2xl tracking-[-0.02em]">
                    {money(cycleCard.balance)}
                  </div>
                  <div className="text-ink-muted mt-1 text-[12.5px]">
                    Cycle {cycleCard.cycleLabel} ·{' '}
                    <span className="text-ink font-mono">{money(cycleCard.cycleSpend)}</span> this
                    cycle
                  </div>
                  <div className="bg-paper-sunk mt-3.5 h-1.5 overflow-hidden rounded-full">
                    <div
                      className="bg-iris h-full rounded-full"
                      style={{ width: `${Math.round(cycleCard.progress * 100)}%` }}
                    />
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {!isEmpty && (
          <div className="mt-5 flex flex-col gap-3 lg:hidden">
            <div className="border-line bg-paper-raised rounded-[18px] border p-4.5">
              <div className="flex items-center gap-4.5">
                <div className="shrink-0">
                  <Ring size="hero-mobile" fraction={hero.usedFraction}>
                    <span className="font-mono text-lg font-medium">
                      {Math.round(Math.min(hero.usedFraction, 1) * 100)}%
                    </span>
                    <span className="text-ink-muted mt-0.5 text-[9px] tracking-[0.08em] uppercase">
                      of budget
                    </span>
                  </Ring>
                </div>
                <div className="min-w-0">
                  {hero.hasBudget && (
                    <div className="mb-1 flex items-center gap-1.5">
                      <span
                        className={cn(
                          'size-1.5 rounded-full',
                          hero.paceTone === 'rose' ? 'bg-rose' : 'bg-iris',
                        )}
                      />
                      <span
                        className={cn(
                          'text-[11px] font-semibold tracking-[0.04em] uppercase',
                          hero.paceTone === 'rose' ? 'text-rose' : 'text-iris',
                        )}
                      >
                        {hero.paceTone === 'rose' ? 'Over pace' : 'On pace'}
                      </span>
                    </div>
                  )}
                  <div className="font-display text-[20px] leading-[1.2] font-semibold tracking-[-0.01em]">
                    {hero.hasBudget ? (
                      <>
                        {hero.leftLabel} <AnimatedMoney value={Number(hero.leftAmount)} />
                      </>
                    ) : (
                      'No budget set'
                    )}
                  </div>
                  <p className="text-ink-muted mt-1.5 text-[12.5px] leading-snug">
                    {hero.paceNote}
                  </p>
                </div>
              </div>
            </div>

            {triage.total > 0 && (
              <div className="border-iris bg-iris-soft rounded-[18px] border p-4">
                <div className="font-display text-[16.5px] font-semibold tracking-[-0.01em]">
                  {triage.total} transaction{triage.total === 1 ? '' : 's'} need
                  {triage.total === 1 ? 's' : ''} a category
                </div>
                <p className="text-ink/80 mt-1.5 text-[12.5px] leading-relaxed">
                  Rules matched {triage.matched} of them. Confirm in a batch, and Track a Loonie
                  will write the rule for next time.
                </p>
                <Link
                  href="/categorize"
                  className="bg-iris text-paper-raised mt-3.5 block w-full rounded-full py-2.5 text-center text-[14.5px] font-semibold"
                >
                  Categorize in batches
                </Link>
              </div>
            )}

            <div className="border-line bg-paper-raised rounded-[18px] border p-4">
              <div className="flex items-baseline justify-between gap-2.5">
                <span className="font-display text-base font-semibold">Cash flow</span>
                <span className="text-ink-muted text-[11.5px]">separate from budgets</span>
              </div>
              <div className="mt-3.5 grid grid-cols-2 gap-3">
                <Link href={overviewIncomeHref(data.month)}>
                  <div className="text-ink-muted text-[10px] tracking-[0.08em] uppercase">In</div>
                  <div className="text-sky mt-0.5 font-mono text-[17px]">{money(hero.income)}</div>
                </Link>
                <Link href={overviewExpenseHref(data.month)}>
                  <div className="text-ink-muted text-[10px] tracking-[0.08em] uppercase">Out</div>
                  <div className="text-rose mt-0.5 font-mono text-[17px]">
                    {money(hero.expense)}
                  </div>
                </Link>
              </div>
              <div className="bg-line my-3.5 h-px" />
              <Link
                href={overviewNetHref(data.month)}
                className="flex items-baseline justify-between gap-2.5"
              >
                <span className="text-ink-muted text-[13px]">Net this month</span>
                <span className="font-mono text-[17px] font-medium">{money(hero.net)}</span>
              </Link>
              <p className="text-ink-muted mt-2.5 text-[11.5px] leading-relaxed">
                Excludes transfers between your own accounts.
              </p>
            </div>

            {budgetRings.length > 0 && (
              <div className="border-line bg-paper-raised rounded-[18px] border p-4">
                <div className="mb-3.5 flex items-baseline justify-between gap-2.5">
                  <span className="font-display text-base font-semibold">Budgets</span>
                  <Link href="/budgets" className="text-iris text-[11.5px] font-medium">
                    See all
                  </Link>
                </div>
                <div className="flex flex-col gap-3.5">
                  {budgetRings.map((r) => {
                    const alert = r.fraction > 0.85;
                    return (
                      <Link
                        key={r.id}
                        href={overviewCategoryHref(data.month, [r.categoryId])}
                        className="block"
                      >
                        <div className="flex items-baseline justify-between gap-2 text-[13px]">
                          <span className="font-medium">{r.categoryName}</span>
                          <span className={cn('font-mono', alert ? 'text-rose' : 'text-iris')}>
                            {money(r.left.replace('Over by ', ''))}
                            {r.over ? ' over' : ' left'}
                          </span>
                        </div>
                        <div className="bg-paper-sunk mt-1.5 flex h-1.5 overflow-hidden rounded-full">
                          <span
                            className={cn('block', alert ? 'bg-rose' : 'bg-iris')}
                            style={{ width: `${Math.round(Math.min(r.fraction, 1) * 100)}%` }}
                          />
                        </div>
                      </Link>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {dayFocus && (
        <div className="lg:hidden" data-testid="day-panel-mobile">
          <DayPanel
            month={data.month}
            selectedDay={selectedDay}
            daysInMonth={data.daysInMonth}
            dayHref={dayHref}
            ringSize="day"
            backHref={month ? `/dashboard?month=${month}` : '/dashboard'}
          />
        </div>
      )}

      <div
        className="border-line bg-paper-raised fixed inset-x-0 z-20 flex gap-2.5 border-t px-4.5 py-2.5 lg:hidden"
        style={{ bottom: 'calc(60px + env(safe-area-inset-bottom))' }}
      >
        <Link
          href="/import"
          className="border-line text-ink flex flex-1 items-center justify-center rounded-full border py-3 text-[14px] font-medium"
        >
          Import CSV
        </Link>
        <Link
          href="?overlay=add"
          className="bg-iris text-paper-raised focus-visible:outline-paper-raised flex flex-[1.3] items-center justify-center gap-2 rounded-full py-3 text-[14.5px] font-semibold focus-visible:outline-2 focus-visible:outline-offset-2"
        >
          <Plus size={16} /> Log a spend
        </Link>
      </div>
    </div>
  );
};

export default DashboardPage;
