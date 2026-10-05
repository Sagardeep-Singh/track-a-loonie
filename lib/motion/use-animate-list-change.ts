'use client';

import { useState } from 'react';
import { isSmallListChange } from '@/lib/motion/list';

/**
 * Whether the latest change to a list's ids is small enough to animate row by
 * row (see `isSmallListChange`). Stays true until the ids change, so
 * unrelated re-renders don't flip it.
 */
export const useAnimateListChange = (ids: readonly string[]): boolean => {
  const key = ids.join('\n');
  const [state, setState] = useState({ key, ids, animate: true });
  if (state.key !== key) {
    const animate = isSmallListChange(state.ids, ids);
    // Render-time update keyed on the ids, React's documented alternative to
    // an effect for deriving state from changing props.
    setState({ key, ids, animate });
    return animate;
  }
  return state.animate;
};
