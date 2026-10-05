import type { Transition } from 'framer-motion';

/**
 * Every spring the app uses. Shared so overlays, lists and charts settle with
 * the same feel instead of each component picking its own numbers.
 */
export const spring = {
  /** Overlays, layout shifts, nav indicators: quick with a hint of overshoot. */
  snappy: { type: 'spring', stiffness: 420, damping: 32 },
  /** Cards, bars, toast entrance: a visible but small bounce. */
  bouncy: { type: 'spring', stiffness: 320, damping: 21 },
  /** Ring fill and count-up: no overshoot, so money never reads past its value. */
  smooth: { type: 'spring', stiffness: 140, damping: 26 },
} as const satisfies Record<string, Transition>;

/** Exits are quick and eased in, never springy: the element is leaving. */
export const exitTransition = { duration: 0.2, ease: [0.4, 0, 1, 1] } as const satisfies Transition;

/** Seconds between items in a staggered list. */
export const STAGGER = 0.06;

/**
 * Props for a row or card in an animated list, spread onto an `m.*` element
 * inside `<AnimatePresence mode="popLayout" initial={false}>` (its parent needs
 * `position: relative`). Siblings glide by position only, so a card whose
 * content changes height doesn't stretch mid-animation.
 *
 * Pass `custom={false}` to that `AnimatePresence` (see `useAnimateListChange`)
 * to make leaving items vanish instantly, e.g. on a page or filter change.
 */
export const listItemMotion = {
  layout: 'position',
  variants: {
    hidden: { opacity: 0, scale: 0.98 },
    shown: { opacity: 1, scale: 1 },
    exit: (animate: boolean = true) =>
      animate
        ? { opacity: 0, x: -48, transition: exitTransition }
        : { opacity: 0, transition: { duration: 0 } },
  },
  initial: 'hidden',
  animate: 'shown',
  exit: 'exit',
  transition: spring.snappy,
} as const;
