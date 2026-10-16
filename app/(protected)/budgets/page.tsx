import { getServerAuthSession } from '@/lib/auth/session';
import { listBudgets } from '@/lib/services/budgets';
import { listCategories } from '@/lib/services/categories';
import { getUncategorizedMonthSummary } from '@/lib/services/categorize';
import { listLimitAndGoalCategoryIds, listSavingsGoals } from '@/lib/services/savingsGoals';
import { getBudgetSettings, getZbbMonth } from '@/lib/services/zeroBased';
import { BudgetsView } from '@/components/budgets/budgets-view';
import { ZeroBasedView } from '@/components/budgets/zero-based-view';
import {
  SavingsGoalsSection,
  SavingsGoalsShortcut,
} from '@/components/budgets/savings-goals-section';
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
  const zeroBased = settings.mode === 'ZERO_BASED';
  const [goals, categories, { limitCategoryIds, goalCategoryIds }] = await Promise.all([
    listSavingsGoals(userId, month),
    listCategories(userId),
    listLimitAndGoalCategoryIds(userId),
  ]);
  const goalsSection = (
    <SavingsGoalsSection
      goals={goals}
      categories={categories}
      unavailableCategoryIds={[...limitCategoryIds, ...goalCategoryIds]}
      month={month}
      zeroBased={zeroBased}
    />
  );

  if (zeroBased) {
    const goalsKey = goals
      .map((g) => `${g.id}:${g.targetAmount}:${g.targetMonth}:${g.startingAmount}`)
      .join('|');
    const zbbMonth = await getZbbMonth(userId, month);
    return (
      <div className="animate-[fade-up_0.3s_ease-out]">
        {header('Give every dollar a job. Leftovers roll over to next month.')}
        <SavingsGoalsShortcut goals={goals} />
        {/* keyed by the goals too: adding or changing one changes rows and targets */}
        <ZeroBasedView key={`${month}:${goalsKey}`} initialMonth={zbbMonth} />
        {goalsSection}
      </div>
    );
  }

  const [budgets, uncategorized] = await Promise.all([
    listBudgets(userId, month),
    getUncategorizedMonthSummary(userId, month),
  ]);
  // a goal's category can't also take a spending limit
  const withGoal = new Set(goalCategoryIds);

  return (
    <div className="animate-[fade-up_0.3s_ease-out]">
      {header('A monthly limit per category. Status follows the limit, not the calendar.')}
      <SavingsGoalsShortcut goals={goals} />
      <BudgetsView
        initialBudgets={budgets}
        categories={categories.filter((c) => !withGoal.has(c.id))}
        month={month}
        uncategorized={uncategorized}
      />
      {goalsSection}
    </div>
  );
};

export default BudgetsPage;
