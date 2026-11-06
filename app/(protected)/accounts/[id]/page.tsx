import { notFound } from 'next/navigation';
import { getServerAuthSession } from '@/lib/auth/session';
import { parseHistoryRange } from '@/lib/account-history';
import { getAccountHistory, type AccountHistory } from '@/lib/services/accountBalances';
import { getAccount, type FrontendAccount } from '@/lib/services/accounts';
import { ServiceValidationError } from '@/lib/services/common';
import { AccountDetailView } from '@/components/accounts/account-detail-view';
import { ScreenHeader } from '@/components/nav/screen-header';

type PageParams = {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ range?: string }>;
};

const AccountPage = async ({ params, searchParams }: PageParams): Promise<React.ReactElement> => {
  const session = await getServerAuthSession();
  const userId = session!.user.id;
  const { id } = await params;
  const range = parseHistoryRange((await searchParams).range);

  // notFound() throws, so it must be called outside the try, or the catch
  // would swallow the 404 interrupt.
  let data: { account: FrontendAccount; history: AccountHistory } | null = null;
  try {
    const [account, history] = await Promise.all([
      getAccount(userId, id),
      getAccountHistory(userId, id, range),
    ]);
    data = { account, history };
  } catch (error) {
    if (!(error instanceof ServiceValidationError)) throw error;
  }
  if (!data) {
    notFound();
  }

  return (
    <div className="animate-[fade-up_0.3s_ease-out]">
      <ScreenHeader
        title={data.account.name}
        description={
          data.account.tracksBalance
            ? 'Tracked by balance updates. Log a new balance whenever you check the account.'
            : 'Balance from your starting balance plus every transaction logged against it.'
        }
      />
      <AccountDetailView account={data.account} history={data.history} />
    </div>
  );
};

export default AccountPage;
