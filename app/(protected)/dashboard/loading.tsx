import { ScreenHeader } from '@/components/nav/screen-header';
import { OverviewSkeleton } from '@/components/dashboard/overview-skeleton';

const DashboardLoading = (): React.ReactElement => (
  <div>
    <ScreenHeader title="Overview" description="Here's where things stand this month." />
    <OverviewSkeleton />
  </div>
);

export default DashboardLoading;
