'use client';

import { useCallback, useMemo, useState } from 'react';
import { loadStripe } from '@stripe/stripe-js';
import { EmbeddedCheckout, EmbeddedCheckoutProvider } from '@stripe/react-stripe-js';
import { postJSON } from '@/lib/api-client';

/**
 * Stripe's embedded payment form, rendered on our page. Stripe hosts the card
 * fields in its own iframe, so card details never reach this app. Submitting
 * creates the subscription and sends the browser to `/upgrade/complete`.
 */
export const EmbeddedCheckoutForm = ({
  publishableKey,
  priceId,
}: {
  publishableKey: string;
  priceId: string;
}): React.ReactElement => {
  const stripePromise = useMemo(() => loadStripe(publishableKey), [publishableKey]);
  const [error, setError] = useState<string | null>(null);

  const fetchClientSecret = useCallback(async (): Promise<string> => {
    const result = await postJSON<{ clientSecret: string }>('/api/billing/checkout', { priceId });
    if (!result.ok) {
      const message = result.error ?? "We couldn't start checkout. Try again in a moment.";
      setError(message);
      throw new Error(message);
    }
    return result.data.clientSecret;
  }, [priceId]);

  if (error) {
    return (
      <p className="bg-rose-soft text-rose rounded-lg px-3 py-2 text-sm" role="alert">
        {error}
      </p>
    );
  }

  return (
    <div id="checkout" data-testid="embedded-checkout">
      <EmbeddedCheckoutProvider stripe={stripePromise} options={{ fetchClientSecret }}>
        <EmbeddedCheckout />
      </EmbeddedCheckoutProvider>
    </div>
  );
};
