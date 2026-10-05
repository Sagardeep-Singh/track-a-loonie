'use client';

import { useReducedMotion, type Transition } from 'framer-motion';

const INSTANT: Transition = { duration: 0 };

/**
 * `MotionConfig reducedMotion="user"` only skips transform and layout
 * animations. Size, stroke and text animations (bars, rings, count-up) go
 * through this so they land instantly for users who asked for less motion.
 */
export const useReducedTransition = (transition: Transition): Transition =>
  useReducedMotion() ? INSTANT : transition;
