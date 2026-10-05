import { getServerAuthSession } from '@/lib/auth/session';
import { listAccounts } from '@/lib/services/accounts';
import { getPendingReimbursementSummary } from '@/lib/services/reimbursements';
import { getBudgetSettings } from '@/lib/services/zeroBased';
import { AccountsView } from '@/components/accounts/accounts-view';
import { ScreenHeader } from '@/components/nav/screen-header';

const AccountsPage = async (): Promise<React.ReactElement> => {
  const session = await getServerAuthSession();
  const [accounts, pendingReimbursement, budgetSettings] = await Promise.all([
    listAccounts(session!.user.id),
    getPendingReimbursementSummary(session!.user.id),
    getBudgetSettings(session!.user.id),
  ]);

  return (
    <div className="animate-[fade-up_0.3s_ease-out]">
      <ScreenHeader
        title="Accounts"
        description="Each balance is your starting balance plus every transaction logged against it."
      />
      <AccountsView
        initialAccounts={accounts}
        pendingReimbursement={pendingReimbursement}
        zeroBased={budgetSettings.mode === 'ZERO_BASED'}
      />
    </div>
  );
};

export default AccountsPage;
