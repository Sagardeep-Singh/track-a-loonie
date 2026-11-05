import { Suspense } from 'react';
import { redirect } from 'next/navigation';
import { getServerAuthSession } from '@/lib/auth/session';
import { Sidebar } from '@/components/nav/sidebar';
import { BottomNav } from '@/components/nav/bottom-nav';
import { AddTransactionOverlay } from '@/components/transactions/add-transaction-overlay';
import { listAccounts } from '@/lib/services/accounts';
import { listCategories } from '@/lib/services/categories';
import { getNavCounts } from '@/lib/services/nav';
import { getEmailVerificationStatus } from '@/lib/services/emailVerification';
import { UnverifiedEmailBanner } from '@/components/nav/unverified-email-banner';
import { getEntitlements, getHistoryFloorMonth } from '@/lib/services/entitlements';
import { PlanProvider } from '@/components/billing/plan-provider';

const ProtectedLayout = async ({
  children,
}: {
  children: React.ReactNode;
}): Promise<React.ReactElement> => {
  const session = await getServerAuthSession();
  if (!session?.user) {
    redirect('/login');
  }

  const [accounts, categories, counts, emailVerification, entitlements, historyFloorMonth] =
    await Promise.all([
      listAccounts(session.user.id),
      listCategories(session.user.id),
      getNavCounts(session.user.id),
      getEmailVerificationStatus(session.user.id),
      getEntitlements(session.user.id),
      getHistoryFloorMonth(session.user.id),
    ]);

  return (
    <PlanProvider value={{ entitlements, historyFloorMonth }}>
      <div className="bg-paper flex min-h-screen">
        <Sidebar accounts={accounts} counts={counts} />
        <main className="min-w-0 flex-1 px-5 pt-8.5 pb-[calc(60px+env(safe-area-inset-bottom)+24px)] lg:px-10 lg:pb-14">
          <div className="mx-auto max-w-none lg:max-w-[1120px]">
            {emailVerification.configured && !emailVerification.verified && (
              <UnverifiedEmailBanner />
            )}
            {children}
          </div>
        </main>
        <BottomNav counts={counts} />
        <Suspense fallback={null}>
          <AddTransactionOverlay accounts={accounts} categories={categories} />
        </Suspense>
      </div>
    </PlanProvider>
  );
};

export default ProtectedLayout;
