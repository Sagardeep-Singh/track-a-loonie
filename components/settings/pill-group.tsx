'use client';

import { useId } from 'react';
import { LayoutGroup, m } from 'framer-motion';
import { cn } from '@/lib/cn';
import { spring } from '@/lib/motion/tokens';
import { pillGroup } from '@/components/settings/pills';

/** A pill row whose active highlight slides between options. */
export const PillGroup = ({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}): React.ReactElement => (
  // Scoped per group so two rows on one card don't share an indicator.
  <LayoutGroup id={useId()}>
    <div className={cn(pillGroup, className)}>{children}</div>
  </LayoutGroup>
);

/** Rendered first inside each pill button; only the active one shows. */
export const PillHighlight = ({ active }: { active: boolean }): React.ReactElement | null =>
  active ? (
    <m.span
      layoutId="pill-active"
      transition={spring.snappy}
      aria-hidden="true"
      className="bg-iris absolute inset-[-1px] rounded-full"
    />
  ) : null;
