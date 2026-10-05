import { getServerAuthSession } from '@/lib/auth/session';
import { listBudgets } from '@/lib/services/budgets';
import { listCategories } from '@/lib/services/categories';
import { getUncategorizedMonthSummary } from '@/lib/services/categorize';
import { getBudgetSettings, getZbbMonth } from '@/lib/services/zeroBased';
import { BudgetsView } from '@/components/budgets/budgets-view';
import { ZeroBasedView } from '@/components/budgets/zero-based-view';
import { ScreenHeader } from '@/components/nav/screen-header';
import { PeriodPopover } from '@/components/dashboard/period-popover';
import { getStoredPeriod } from '@/lib/period-cookie';
import { selectionMonth } from '@/lib/period-selection';

const currentMonth = (): number => {
  const now = new Date();
  return now.getUTCFullYear() * 100 + (now.getUTCMonth() + 1);
};

const BudgetsPage = async ({
  searchParams,
}: {
  searchParams: Promise<{ month?: string }>;
}): Promise<React.ReactElement> => {
  const { month: monthParam } = await searchParams;
  const session = await getServerAuthSession();
  const userId = session!.user.id;
  // No month in the URL: open on the period last picked on any screen.
  const month = monthParam
    ? Number(monthParam)
    : selectionMonth(await getStoredPeriod(), currentMonth());
  const header = (description: string): React.ReactElement => (
    <ScreenHeader
      title="Budgets"
      description={description}
      periodSlot={<PeriodPopover month={month} basePath="/budgets" />}
    />
  );

  const settings = await getBudgetSettings(userId);
  if (settings.mode === 'ZERO_BASED') {
    const zbbMonth = await getZbbMonth(userId, month);
    return (
      <div className="animate-[fade-up_0.3s_ease-out]">
        {header('Give every dollar a job. Leftovers roll over to next month.')}
        <ZeroBasedView key={month} initialMonth={zbbMonth} />
      </div>
    );
  }

  const [budgets, categories, uncategorized] = await Promise.all([
    listBudgets(userId, month),
    listCategories(userId),
    getUncategorizedMonthSummary(userId, month),
  ]);

  return (
    <div className="animate-[fade-up_0.3s_ease-out]">
      {header('A monthly limit per category. Status follows the limit, not the calendar.')}
      <BudgetsView
        initialBudgets={budgets}
        categories={categories}
        month={month}
        uncategorized={uncategorized}
      />
    </div>
  );
};

export default BudgetsPage;
