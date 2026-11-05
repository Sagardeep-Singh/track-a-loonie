import { NextResponse } from 'next/server';
import { isBillingEnabled } from '@/lib/billing/stripe';
import { constructStripeEvent, handleStripeEvent } from '@/lib/services/billing';

/**
 * Stripe → app. No session: the signature over the raw body is the auth, so
 * the body is read as text and never re-serialized before verifying.
 */
export const POST = async (request: Request): Promise<NextResponse> => {
  if (!isBillingEnabled()) {
    return NextResponse.json({ error: 'Billing is not enabled' }, { status: 404 });
  }
  const signature = request.headers.get('stripe-signature');
  if (!signature) {
    return NextResponse.json({ error: 'Missing signature' }, { status: 400 });
  }

  const payload = await request.text();
  let event;
  try {
    event = constructStripeEvent(payload, signature);
  } catch {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 400 });
  }

  await handleStripeEvent(event);
  return NextResponse.json({ received: true });
};
