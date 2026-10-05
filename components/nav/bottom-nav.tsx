'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { m } from 'framer-motion';
import { LayoutDashboard, LogOut, MoreHorizontal, PiggyBank, Receipt, Tag } from 'lucide-react';
import { Modal } from '@/components/ui/modal';
import { SidebarNav } from '@/components/nav/sidebar-nav';
import { signOutAction } from '@/lib/auth/actions';
import { buildMoreItems } from '@/lib/nav/items';
import { cn } from '@/lib/cn';
import { spring } from '@/lib/motion/tokens';
import type { NavCounts } from '@/lib/services/nav';

/**
 * Mobile-only counterpart to Sidebar: four direct destinations plus a "More"
 * modal holding the remaining five nav items and sign-out. Hidden at lg+,
 * where the sidebar takes over.
 */
export const BottomNav = ({ counts }: { counts: NavCounts }): React.ReactElement => {
  const pathname = usePathname();
  const [moreOpen, setMoreOpen] = useState(false);
  // Remount the Modal per open so its <dialog> state can't drift out of sync,
  // matching the keyed-dialog pattern used elsewhere in the app.
  const [dialogKey, setDialogKey] = useState(0);

  const openMore = (): void => {
    setDialogKey((k) => k + 1);
    setMoreOpen(true);
  };
  const closeMore = (): void => setMoreOpen(false);

  const items = [
    {
      href: '/dashboard',
      label: 'Overview',
      icon: <LayoutDashboard size={20} />,
      showDot: false,
      alert: false,
    },
    {
      href: '/transactions',
      label: 'Transactions',
      icon: <Receipt size={20} />,
      showDot: false,
      alert: false,
    },
    {
      href: '/categorize',
      label: 'Categorize',
      icon: <Tag size={20} />,
      showDot: counts.categorize > 0,
      alert: true,
    },
    {
      href: '/budgets',
      label: 'Budgets',
      icon: <PiggyBank size={20} />,
      showDot: false,
      alert: false,
    },
  ];

  return (
    <>
      <nav
        aria-label="Primary"
        className="border-line bg-paper-raised/95 fixed inset-x-0 bottom-0 z-30 flex h-[60px] items-stretch justify-around border-t pb-[env(safe-area-inset-bottom)] backdrop-blur-sm lg:hidden"
      >
        {items.map((item) => {
          const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'focus-visible:outline-iris relative flex flex-1 flex-col items-center justify-center gap-0.5 rounded-lg text-[10.5px] font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2',
                active ? 'text-iris' : 'text-ink-muted',
              )}
            >
              {/* Soft pill behind the active icon; slides between tabs since
                  this nav lives in the layout and survives route changes. */}
              {active && (
                <m.span
                  layoutId="bottom-nav-active"
                  transition={spring.snappy}
                  aria-hidden="true"
                  className="bg-iris-soft absolute inset-x-0 top-[7px] mx-auto h-7 w-14 rounded-full"
                />
              )}
              <span className="relative">{item.icon}</span>
              <span className="relative">{item.label}</span>
              {item.showDot && (
                <span
                  data-testid={`nav-dot-${item.label.toLowerCase()}`}
                  className={cn(
                    'absolute top-1.5 right-[26%] size-1.5 rounded-full',
                    item.alert ? 'bg-rose' : 'bg-iris',
                  )}
                />
              )}
            </Link>
          );
        })}
        <button
          type="button"
          onClick={openMore}
          aria-haspopup="dialog"
          className="text-ink-muted focus-visible:outline-iris flex flex-1 flex-col items-center justify-center gap-0.5 rounded-lg text-[10.5px] font-medium focus-visible:outline-2 focus-visible:outline-offset-2"
        >
          <MoreHorizontal size={20} />
          <span>More</span>
        </button>
      </nav>

      <Modal key={`more-${dialogKey}`} open={moreOpen} onClose={closeMore} title="More">
        <SidebarNav items={buildMoreItems()} onNavigate={closeMore} />
        <form action={signOutAction} className="border-line mt-4 border-t pt-4">
          <button
            type="submit"
            className="text-ink-muted hover:text-ink focus-visible:outline-iris inline-flex cursor-pointer items-center gap-1 rounded text-xs transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2"
          >
            <LogOut size={13} />
            Sign out
          </button>
        </form>
      </Modal>
    </>
  );
};
