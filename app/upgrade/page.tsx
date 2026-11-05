import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { getServerAuthSession } from '@/lib/auth/session';
import { isBillingEnabled } from '@/lib/billing/stripe';
import { formatPlanPrice, intervalLabel } from '@/lib/billing/format';
import { getBillingSummary, listPlans } from '@/lib/services/billing';
import { EmbeddedCheckoutForm } from '@/components/billing/embedded-checkout-form';
import { PlanFeatures } from '@/components/billing/plan-features';
import { Card } from '@/components/ui/card';

export const dynamic = 'force-dynamic';

const BackLink = (): React.ReactElement => (
  <Link
    href="/dashboard"
    className="text-ink-muted hover:text-ink inline-flex items-center gap-1.5 text-sm"
  >
    <ArrowLeft size={14} aria-hidden />
    Back to Track a Loonie
  </Link>
);

const Notice = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <div className="max-w-[520px]">
    <BackLink />
    <h1 className="font-display text-ink mt-6 text-[32px] font-semibold tracking-[-0.025em]">
      {title}
    </h1>
    <div className="text-ink-muted mt-3 text-sm">{children}</div>
  </div>
);

/**
 * Where every "Upgrade to Plus" lands, including the marketing pricing page.
 * Lives outside `(protected)` so a signed-out visitor can be sent through
 * sign-in and brought back here with `?next=`.
 */
const UpgradePage = async ({
  searchParams,
}: {
  searchParams: Promise<{ price?: string }>;
}): Promise<React.ReactElement> => {
  const { price: requestedPrice } = await searchParams;
  const session = await getServerAuthSession();
  if (!session?.user) {
    const next = requestedPrice ? `/upgrade?price=${requestedPrice}` : '/upgrade';
    redirect(`/login?next=${encodeURIComponent(next)}`);
  }

  const publishableKey = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;
  if (!isBillingEnabled() || !publishableKey) {
    return (
      <Notice title="Upgrades aren't available here">
        This deployment doesn&rsquo;t take payments, so every feature is already on.
      </Notice>
    );
  }

  const [summary, plans] = await Promise.all([getBillingSummary(session.user.id), listPlans()]);
  if (summary.isPaid) {
    return (
      <Notice title={`You're on ${summary.planName}`}>
        Change your plan, card or billing from{' '}
        <Link href="/settings" className="text-iris font-medium">
          Settings
        </Link>
        .
      </Notice>
    );
  }

  const plan = plans.find((p) => p.prices.some((price) => price.id === requestedPrice)) ?? plans[0];
  if (!plan) {
    return (
      <Notice title="No plans to choose from yet">
        Check back soon, or keep using Free in the meantime.
      </Notice>
    );
  }
  const price = plan.prices.find((p) => p.id === requestedPrice) ?? plan.prices[0];

  return (
    <div className="animate-[fade-up_0.3s_ease-out]">
      <BackLink />
      <div className="mt-6 grid grid-cols-1 gap-8 lg:grid-cols-[minmax(0,360px)_minmax(0,1fr)]">
        <Card className="h-fit">
          <p className="text-ink-muted text-xs font-medium tracking-[0.09em] uppercase">
            Upgrade to
          </p>
          <h1 className="font-display text-ink mt-1 text-[28px] font-semibold tracking-[-0.025em]">
            {plan.name}
          </h1>
          {plan.description && <p className="text-ink-muted mt-2 text-sm">{plan.description}</p>}
          <p className="mt-5 flex items-baseline gap-2">
            <span className="font-display text-ink text-[40px] font-semibold">
              {formatPlanPrice(price.unitAmount, price.currency)}
            </span>
            <span className="text-ink-muted text-sm">{intervalLabel(price.interval)}</span>
          </p>
          <div className="border-line mt-5 border-t pt-5">
            <PlanFeatures entitlements={plan.entitlements} />
          </div>
          <p className="text-ink-muted mt-5 text-xs">
            Prices in {price.currency.toUpperCase()}. Cancel anytime from Settings.
          </p>
        </Card>
        <div className="min-w-0">
          <EmbeddedCheckoutForm publishableKey={publishableKey} priceId={price.id} />
        </div>
      </div>
    </div>
  );
};

export default UpgradePage;
