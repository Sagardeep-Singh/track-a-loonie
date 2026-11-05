import { useSyncExternalStore } from 'react';

/**
 * The budgeting mode, mirrored into a cookie so loading skeletons can match
 * the screen that's about to render. Skeletons are prefetched and render
 * before any data, so they can't ask the server. This is a display hint
 * only: nothing reads it to decide what data to show.
 */
export const BUDGET_MODE_COOKIE = 'tal_budget_mode';

export type StoredBudgetMode = 'LIMITS' | 'ZERO_BASED';

export const readBudgetModeCookie = (cookieHeader: string): StoredBudgetMode | null => {
  const match = cookieHeader
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${BUDGET_MODE_COOKIE}=`));
  const value = match?.slice(BUDGET_MODE_COOKIE.length + 1);
  return value === 'LIMITS' || value === 'ZERO_BASED' ? value : null;
};

export const writeBudgetModeCookie = (mode: StoredBudgetMode): void => {
  if (typeof document === 'undefined') return;
  if (readBudgetModeCookie(document.cookie) === mode) return;
  document.cookie = `${BUDGET_MODE_COOKIE}=${mode}; path=/; max-age=31536000; samesite=lax`;
};

const noSubscribe = (): (() => void) => () => {};

/**
 * The mode a skeleton should draw. Limits until the cookie says otherwise,
 * and on the server, where there's no cookie to read here.
 */
export const useStoredBudgetMode = (): StoredBudgetMode =>
  useSyncExternalStore(
    noSubscribe,
    () => readBudgetModeCookie(document.cookie) ?? 'LIMITS',
    () => 'LIMITS',
  );
