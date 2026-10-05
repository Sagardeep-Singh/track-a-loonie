'use client';

import { m } from 'framer-motion';
import { spring, STAGGER } from '@/lib/motion/tokens';
import { useReducedTransition } from '@/lib/motion/use-reduced-transition';

/**
 * A bar that grows from zero to `size` on mount and eases between sizes after
 * that. Client wrapper so server-rendered charts can animate their bars.
 */
export const GrowBar = ({
  axis,
  size,
  index = 0,
  className,
  style,
  title,
  children,
}: {
  axis: 'width' | 'height';
  /** CSS length, e.g. `42%`. */
  size: string;
  /** Position in its row, for a short stagger. */
  index?: number;
  className?: string;
  style?: React.CSSProperties;
  title?: string;
  children?: React.ReactNode;
}): React.ReactElement => {
  const transition = useReducedTransition({ ...spring.smooth, delay: index * STAGGER });
  return (
    <m.div
      className={className}
      style={style}
      title={title}
      initial={{ [axis]: 0 }}
      animate={{ [axis]: size }}
      transition={transition}
    >
      {children}
    </m.div>
  );
};
