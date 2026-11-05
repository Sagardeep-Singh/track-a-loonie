'use client';

import { createContext, useContext } from 'react';
import { UNLIMITED_ENTITLEMENTS, type Entitlements } from '@/lib/billing/entitlements';

export type PlanContextValue = {
  entitlements: Entitlements;
  /** `YYYYMM` of the oldest month the user can browse; null = all history */
  historyFloorMonth: number | null;
};

// Outside the protected layout (auth pages, tests) nothing is restricted:
// the server enforces the plan either way, this only drives the UI.
const PlanContext = createContext<PlanContextValue>({
  entitlements: UNLIMITED_ENTITLEMENTS,
  historyFloorMonth: null,
});

/** The signed-in user's plan for client components, read once in the protected layout. */
export const PlanProvider = ({
  value,
  children,
}: {
  value: PlanContextValue;
  children: React.ReactNode;
}): React.ReactElement => <PlanContext.Provider value={value}>{children}</PlanContext.Provider>;

export const usePlan = (): PlanContextValue => useContext(PlanContext);
