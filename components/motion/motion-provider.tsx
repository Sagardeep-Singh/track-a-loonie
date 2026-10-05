'use client';

import { LazyMotion, MotionConfig } from 'framer-motion';

const loadFeatures = (): Promise<typeof import('@/lib/motion/features').default> =>
  import('@/lib/motion/features').then((mod) => mod.default);

/**
 * App-wide motion setup. `strict` makes any accidental full `motion.*`
 * component throw in dev, so only the lightweight `m.*` ships. `reducedMotion`
 * honours the OS setting: transform and layout animations are skipped,
 * opacity changes still apply.
 */
export const MotionProvider = ({ children }: { children: React.ReactNode }): React.ReactElement => (
  <LazyMotion features={loadFeatures} strict>
    <MotionConfig reducedMotion="user">{children}</MotionConfig>
  </LazyMotion>
);
