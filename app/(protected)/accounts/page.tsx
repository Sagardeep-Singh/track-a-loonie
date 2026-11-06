import { getServerAuthSession } from '@/lib/auth/session';
import { parseHistoryRange } from '@/lib/account-history';
import { getNetWorthHistory } from '@/lib/services/accountBalances';
import { listAccounts } from '@/lib/services/accounts';
import { getPendingReimbursementSummary } from '@/lib/services/reimbursements';
import { getBudgetSettings } from '@/lib/services/zeroBased';
import { AccountsView } from '@/components/accounts/accounts-view';
import { ScreenHeader } from '@/components/nav/screen-header';

const AccountsPage = async ({
  searchParams,
}: {
  searchParams: Promise<{ range?: string }>;
}): Promise<React.ReactElement> => {
  const session = await getServerAuthSession();
  const range = parseHistoryRange((await searchParams).range);
  const [accounts, pendingReimbursement, budgetSettings, netWorthHistory] = await Promise.all([
    listAccounts(session!.user.id),
    getPendingReimbursementSummary(session!.user.id),
    getBudgetSettings(session!.user.id),
    getNetWorthHistory(session!.user.id, range),
  ]);

  return (
    <div className="animate-[fade-up_0.3s_ease-out]">
      <ScreenHeader
        title="Accounts"
        description="Each balance is your starting balance plus every transaction logged against it, or the latest balance you logged for balance-tracked accounts."
      />
      <AccountsView
        initialAccounts={accounts}
        pendingReimbursement={pendingReimbursement}
        netWorthHistory={netWorthHistory}
        zeroBased={budgetSettings.mode === 'ZERO_BASED'}
      />
    </div>
  );
};

export default AccountsPage;
