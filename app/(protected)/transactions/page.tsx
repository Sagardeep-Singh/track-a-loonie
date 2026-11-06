import { getServerAuthSession } from '@/lib/auth/session';
import { getTransactionsPage } from '@/lib/services/transactionsPage';
import { listAccounts } from '@/lib/services/accounts';
import { listCategories } from '@/lib/services/categories';
import { parseTransactionFilters } from '@/lib/transactions/transaction-filters';
import type { TransactionScope } from '@/lib/transactions/transaction-scope';
import {
  TRANSACTIONS_PAGE_SIZE,
  transactionsPageSearchParams,
} from '@/lib/transactions/transactions-page-query';
import { TransactionsView } from '@/components/transactions/transactions-view';
import { ScreenHeader } from '@/components/nav/screen-header';
import { DateRangePopover } from '@/components/dashboard/period-popover';

/** First value wins for repeated params. */
const toUrlSearchParams = (raw: Record<string, string | string[] | undefined>): URLSearchParams => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(raw)) {
    const first = Array.isArray(value) ? value[0] : value;
    if (first !== undefined) params.set(key, first);
  }
  return params;
};

// A bare /transactions is redirected to the stored or current period by
// `proxy.ts` before this renders.
const TransactionsPage = async ({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.ReactElement> => {
  const session = await getServerAuthSession();
  const userId = session!.user.id;
  // mobile search is view state, so a fresh load starts without it
  const scope: TransactionScope = {
    filters: parseTransactionFilters(toUrlSearchParams(await searchParams)),
    mobileSearch: '',
  };
  const [initialPage, accounts, categories] = await Promise.all([
    getTransactionsPage(userId, { ...scope, limit: TRANSACTIONS_PAGE_SIZE }),
    listAccounts(userId),
    listCategories(userId),
  ]);

  return (
    <div className="animate-[fade-up_0.3s_ease-out]">
      <ScreenHeader
        title="Transactions"
        description="Every dollar in and out, in one ledger."
        // shallow: the view refetches on its own
        periodSlot={<DateRangePopover shallow />}
      />
      <TransactionsView
        initialPage={initialPage}
        initialRequestKey={transactionsPageSearchParams(scope).toString()}
        // balance-tracked accounts never hold transactions
        accounts={accounts.filter((a) => !a.tracksBalance)}
        categories={categories}
      />
    </div>
  );
};

export default TransactionsPage;
