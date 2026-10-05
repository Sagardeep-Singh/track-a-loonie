'use client';

import { useId } from 'react';
import Link from 'next/link';
import { LayoutGroup, m } from 'framer-motion';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/cn';
import { spring } from '@/lib/motion/tokens';

export type SidebarNavItem = {
  href: string;
  label: string;
  /** A rendered icon element, not a component reference — this crosses a server/client
   * boundary (Sidebar is a server component, SidebarNav is a client component), and only
   * serializable React elements survive that hop, not component types/functions. */
  icon: React.ReactNode;
  badge?: number;
  /** Categorize is treated as an alert queue: its badge tints rose when inactive. */
  alert?: boolean;
};

export const SidebarNav = ({
  items,
  onNavigate,
}: {
  items: SidebarNavItem[];
  /** Called when an item is tapped — lets the mobile "More" modal close itself,
   * since BottomNav lives in the layout and survives the route change. */
  onNavigate?: () => void;
}): React.ReactElement => {
  const pathname = usePathname();
  // Rendered twice (sidebar and the mobile "More" modal): scoping the
  // indicator's layoutId per instance keeps the two from animating into each other.
  const groupId = useId();

  return (
    <LayoutGroup id={groupId}>
      <div className="flex flex-col gap-0.5">
        {items.map((item) => {
          const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
          return (
            <Link
              key={item.href}
              href={item.href}
              onClick={onNavigate}
              className={cn(
                'relative flex items-center justify-between gap-2 rounded-full px-3 py-2.5 text-sm font-medium transition-colors',
                active ? 'text-paper-raised' : 'text-ink hover:bg-paper',
              )}
            >
              {/* The active pill slides between items as the route changes. */}
              {active && (
                <m.span
                  layoutId="nav-active"
                  transition={spring.snappy}
                  aria-hidden="true"
                  className="bg-iris absolute inset-0 rounded-full"
                />
              )}
              <span className="relative flex items-center gap-2">
                {item.icon}
                <span>{item.label}</span>
              </span>
              {item.badge !== undefined && (
                <span
                  data-testid={`nav-badge-${item.label.toLowerCase()}`}
                  className={cn(
                    'relative rounded-full px-1.5 py-0.5 font-mono text-[11px] tabular-nums',
                    active
                      ? 'bg-paper-raised/20 text-paper-raised'
                      : item.alert
                        ? 'bg-rose-soft text-rose'
                        : 'bg-paper-sunk text-ink-muted',
                  )}
                >
                  {item.badge}
                </span>
              )}
            </Link>
          );
        })}
      </div>
    </LayoutGroup>
  );
};
