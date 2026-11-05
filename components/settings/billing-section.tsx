'use client';

import { useState } from 'react';
import { CreditCard } from 'lucide-react';
import { postJSON } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { UpgradeLink } from '@/components/billing/upgrade-prompt';
import type { BillingSummary } from '@/lib/services/billing';

const DATE = new Intl.DateTimeFormat('en-CA', { dateStyle: 'long', timeZone: 'UTC' });

const statusLine = (billing: BillingSummary): string => {
  if (!billing.isPaid) {
    const { limits, historyMonths } = billing.entitlements;
    return `${limits.accounts ?? 'Unlimited'} accounts and your last ${historyMonths ?? 'all'} months. Plus unlocks everything.`;
  }
  const end = billing.currentPeriodEnd ? DATE.format(new Date(billing.currentPeriodEnd)) : null;
  if (billing.status === 'PAST_DUE') {
    return "Your last payment didn't go through. Update your card to keep Plus.";
  }
  if (billing.cancelAtPeriodEnd) return end ? `Ends on ${end}. You won't be charged again.` : '';
  return end ? `Renews on ${end}.` : '';
};

/** Current plan, and the way out to Stripe (portal) or in (checkout). */
export const BillingSection = ({ billing }: { billing: BillingSummary }): React.ReactElement => {
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const openPortal = async (): Promise<void> => {
    setOpening(true);
    setError(null);
    const result = await postJSON<{ url: string }>('/api/billing/portal');
    if (!result.ok) {
      setOpening(false);
      setError(result.error ?? "Couldn't open billing. Try again in a moment.");
      return;
    }
    window.location.assign(result.data.url);
  };

  return (
    <div className="border-line bg-paper-raised rounded-2xl border p-5">
      <h2 className="font-display text-[15px] font-semibold">Plan</h2>
      <div className="flex flex-wrap items-center gap-5 py-3.5">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium" data-testid="current-plan">
            {billing.planName}
          </div>
          <div className="text-ink-muted mt-0.5 text-[12.5px]">{statusLine(billing)}</div>
        </div>
        {billing.isPaid || billing.canManage ? (
          <div className="flex flex-wrap gap-2">
            {!billing.isPaid && <UpgradeLink />}
            <Button variant="secondary" icon={CreditCard} loading={opening} onClick={openPortal}>
              Manage billing
            </Button>
          </div>
        ) : (
          <UpgradeLink />
        )}
      </div>
      {error && (
        <p className="bg-rose-soft text-rose rounded-lg px-3 py-2 text-sm" role="alert">
          {error}
        </p>
      )}
    </div>
  );
};
