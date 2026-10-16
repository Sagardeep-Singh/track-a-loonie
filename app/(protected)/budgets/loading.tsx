import { ScreenHeader } from '@/components/nav/screen-header';
import { BudgetsSkeleton } from '@/components/budgets/budgets-skeleton';

const BudgetsLoading = (): React.ReactElement => (
  <div>
    <ScreenHeader title="Budgets" description="Set a monthly limit per category and track it." />
    <BudgetsSkeleton />
  </div>
);

export default BudgetsLoading;
