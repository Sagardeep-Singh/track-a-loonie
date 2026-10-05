'use client';

import { useCallback } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Drawer } from '@/components/ui/drawer';
import { TransactionForm } from '@/components/transactions/transaction-form';
import { LogASpendMobile } from '@/components/transactions/log-a-spend-mobile';
import type { FrontendAccount } from '@/lib/services/accounts';
import type { FrontendCategory } from '@/lib/services/categories';

/**
 * The sidebar's "+ Log a transaction" opens this from any screen via
 * ?overlay=add — URL-driven so no context provider is needed and the
 * back button closes it, consistent with Overview's ?day=N pattern.
 */
export const AddTransactionOverlay = ({
  accounts,
  categories,
}: {
  accounts: FrontendAccount[];
  categories: FrontendCategory[];
}): React.ReactElement => {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const open = searchParams.get('overlay') === 'add';

  // Memoized: LogASpendMobile's focus-trap/scroll-lock effect depends on
  // this identity — a new function on every render would tear down and
  // re-run that effect on any parent re-render (e.g. router.refresh()),
  // re-locking scroll and yanking focus back to the close button mid-entry.
  // Drops only `overlay`. Reads `window.location` so the callback stays stable across URL changes.
  const close = useCallback((): void => {
    const params = new URLSearchParams(window.location.search);
    params.delete('overlay');
    const query = params.toString();
    router.push(query ? `${pathname}?${query}` : pathname);
  }, [router, pathname]);

  // Same ?overlay=add contract, two shells: the desktop drawer and the
  // mobile full-screen keypad screen. Both remount their contents on every
  // open so local state resets: the drawer unmounts its children once its
  // exit animation finishes, the mobile shell is gated on `open` directly.
  return (
    <>
      <div className="hidden lg:block">
        <Drawer open={open} onClose={close} title="Log a transaction">
          <TransactionForm accounts={accounts} categories={categories} onDone={close} />
        </Drawer>
      </div>
      <div className="lg:hidden">
        {open && <LogASpendMobile accounts={accounts} categories={categories} onDone={close} />}
      </div>
    </>
  );
};
