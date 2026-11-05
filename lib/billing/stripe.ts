import Stripe from 'stripe';

declare global {
  var __stripe: Stripe | undefined;
}

/**
 * Billing is optional, like Google sign-in and push reminders: with no
 * `STRIPE_SECRET_KEY` the billing UI is hidden and every user gets
 * UNLIMITED_ENTITLEMENTS, so a self-hosted install keeps working unchanged.
 */
export const isBillingEnabled = (env: NodeJS.ProcessEnv = process.env): boolean =>
  !!env.STRIPE_SECRET_KEY;

/** Server-only Stripe client. Throws when billing is off; callers check first. */
export const getStripe = (): Stripe => {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('STRIPE_SECRET_KEY is not set');
  // The SDK pins its own API version, so a package upgrade is the only thing
  // that moves it.
  global.__stripe ??= new Stripe(key, { appInfo: { name: 'Track a Loonie' } });
  return global.__stripe;
};
