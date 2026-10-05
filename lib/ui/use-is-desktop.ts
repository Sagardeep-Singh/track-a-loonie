'use client';

import { useSyncExternalStore } from 'react';
import { DESKTOP_MEDIA_QUERY } from '@/lib/ui/viewport';

const subscribe = (onChange: () => void): (() => void) => {
  const query = window.matchMedia(DESKTOP_MEDIA_QUERY);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
};

/**
 * Reactive `lg+` check for render-time decisions (which way an overlay
 * animates). Reports mobile during SSR and hydration, then the real value.
 */
export const useIsDesktop = (): boolean =>
  useSyncExternalStore(
    subscribe,
    () => window.matchMedia(DESKTOP_MEDIA_QUERY).matches,
    () => false,
  );
