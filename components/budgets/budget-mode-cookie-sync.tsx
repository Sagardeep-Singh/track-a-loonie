'use client';

import { useEffect } from 'react';
import { writeBudgetModeCookie, type StoredBudgetMode } from '@/lib/budget-mode-cookie';

/** keeps the skeleton hint cookie in line with the mode the server rendered */
export const BudgetModeCookieSync = ({ mode }: { mode: StoredBudgetMode }): null => {
  useEffect(() => writeBudgetModeCookie(mode), [mode]);
  return null;
};
