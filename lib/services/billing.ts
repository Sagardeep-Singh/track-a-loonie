import { Prisma, type SubscriptionStatus } from '@prisma/client';
import type Stripe from 'stripe';
import { prisma } from '@/lib/db/prisma';
import { appBaseUrl } from '@/lib/http/appUrl';
import {
  parseEntitlementsMetadata,
  readStoredEntitlements,
  type Entitlements,
} from '@/lib/billing/entitlements';
import { getStripe, isBillingEnabled } from '@/lib/billing/stripe';
import { ServiceValidationError } from '@/lib/services/common';
import { ENTITLED_STATUSES, getEntitlements } from '@/lib/services/entitlements';

/**
 * Stripe is the source of truth for paid plans and subscriptions. This
 * service mirrors them into Plan / PlanPrice / Subscription (webhook and
 * checkout return both write here) and owns every Stripe API call.
 *
 * Only products with `plan=true` metadata are treated as app plans, so other
 * products on the same Stripe account are ignored.
 */

export type FrontendPlanPrice = {
  /** the Stripe price id, what checkout takes */
  id: string;
  unitAmount: number;
  currency: string;
  interval: string;
};

export type FrontendPlan = {
  id: string;
  name: string;
  description: string | null;
  entitlements: Entitlements;
  prices: FrontendPlanPrice[];
};

export type BillingSummary = {
  enabled: boolean;
  /** "Free" when the user has no entitled subscription */
  planName: string;
  isPaid: boolean;
  status: SubscriptionStatus | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  /** the portal needs a Stripe customer to open */
  canManage: boolean;
  entitlements: Entitlements;
};

export type CheckoutResult = { status: 'complete' | 'open' | 'expired' };

const STATUS_MAP: Record<string, SubscriptionStatus> = {
  active: 'ACTIVE',
  trialing: 'TRIALING',
  past_due: 'PAST_DUE',
  unpaid: 'UNPAID',
  canceled: 'CANCELED',
  incomplete: 'INCOMPLETE',
  incomplete_expired: 'INCOMPLETE_EXPIRED',
  paused: 'PAUSED',
};

const isAppPlan = (product: Stripe.Product): boolean => product.metadata?.plan === 'true';

const idOf = (value: string | { id: string } | null): string | null =>
  value === null ? null : typeof value === 'string' ? value : value.id;

const assertBillingEnabled = (): void => {
  if (!isBillingEnabled()) throw new ServiceValidationError('Billing is not set up here.');
};

export const listPlans = async (): Promise<FrontendPlan[]> => {
  const plans = await prisma.plan.findMany({
    where: { isActive: true },
    include: { prices: { where: { isActive: true }, orderBy: { unitAmount: 'asc' } } },
  });
  return plans
    .filter((p) => p.prices.length > 0)
    .map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      entitlements: readStoredEntitlements(p.entitlements),
      prices: p.prices.map((price) => ({
        id: price.stripePriceId,
        unitAmount: price.unitAmount,
        currency: price.currency,
        interval: price.interval,
      })),
    }))
    .sort((a, b) => a.prices[0].unitAmount - b.prices[0].unitAmount);
};

export const getBillingSummary = async (userId: string): Promise<BillingSummary> => {
  const [entitlements, user] = await Promise.all([
    getEntitlements(userId),
    prisma.user.findUnique({
      where: { id: userId },
      select: {
        stripeCustomerId: true,
        subscription: { include: { plan: { select: { name: true } } } },
      },
    }),
  ]);
  const subscription = user?.subscription ?? null;
  const isPaid = !!subscription && ENTITLED_STATUSES.includes(subscription.status);
  return {
    enabled: isBillingEnabled(),
    planName: isPaid ? subscription.plan.name : 'Free',
    isPaid,
    status: subscription?.status ?? null,
    currentPeriodEnd: isPaid ? subscription.currentPeriodEnd.toISOString() : null,
    cancelAtPeriodEnd: isPaid ? subscription.cancelAtPeriodEnd : false,
    canManage: !!user?.stripeCustomerId,
    entitlements,
  };
};

const getOrCreateCustomerId = async (userId: string): Promise<string> => {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true, name: true, stripeCustomerId: true },
  });
  if (!user) throw new ServiceValidationError('Your session is no longer valid. Sign in again.');
  if (user.stripeCustomerId) return user.stripeCustomerId;

  const customer = await getStripe().customers.create({
    email: user.email,
    name: user.name ?? undefined,
    metadata: { userId },
  });
  // Only set it if nothing else did in the meantime; reread to use the winner.
  await prisma.user.updateMany({
    where: { id: userId, stripeCustomerId: null },
    data: { stripeCustomerId: customer.id },
  });
  const saved = await prisma.user.findUnique({
    where: { id: userId },
    select: { stripeCustomerId: true },
  });
  return saved?.stripeCustomerId ?? customer.id;
};

/** Starts an embedded checkout for one plan price; returns its client secret. */
export const createCheckoutSession = async (
  userId: string,
  priceId: string,
): Promise<{ clientSecret: string }> => {
  assertBillingEnabled();
  const price = await prisma.planPrice.findFirst({
    where: { stripePriceId: priceId, isActive: true, plan: { isActive: true } },
  });
  if (!price) throw new ServiceValidationError('That plan is not available.');

  const existing = await prisma.subscription.findFirst({
    where: { userId, status: { in: ENTITLED_STATUSES } },
  });
  if (existing) {
    throw new ServiceValidationError(
      'You already have a subscription. Manage it from Settings → Billing.',
    );
  }

  const customer = await getOrCreateCustomerId(userId);
  const session = await getStripe().checkout.sessions.create({
    mode: 'subscription',
    ui_mode: 'embedded_page',
    customer,
    client_reference_id: userId,
    line_items: [{ price: priceId, quantity: 1 }],
    subscription_data: { metadata: { userId } },
    return_url: `${appBaseUrl()}/upgrade/complete?session_id={CHECKOUT_SESSION_ID}`,
  });
  if (!session.client_secret) throw new Error('Stripe returned no client secret');
  return { clientSecret: session.client_secret };
};

/**
 * Where a returning checkout landed. A completed one syncs the subscription
 * right away so the user sees Plus without waiting on the webhook; the
 * webhook's own sync is then a no-op.
 */
export const getCheckoutResult = async (
  userId: string,
  sessionId: string,
): Promise<CheckoutResult> => {
  assertBillingEnabled();
  let session: Stripe.Checkout.Session;
  try {
    session = await getStripe().checkout.sessions.retrieve(sessionId);
  } catch (error) {
    // a hand-edited or stale session_id
    if ((error as { type?: string }).type === 'StripeInvalidRequestError') {
      throw new ServiceValidationError('Checkout session not found.');
    }
    throw error;
  }
  if (session.client_reference_id !== userId) {
    throw new ServiceValidationError('Checkout session not found.');
  }
  if (session.status === 'complete') {
    const subscriptionId = idOf(session.subscription);
    if (subscriptionId) await syncSubscription(subscriptionId);
    return { status: 'complete' };
  }
  return { status: session.status === 'open' ? 'open' : 'expired' };
};

/** Stripe Customer Portal: switch plan, update the card, cancel. */
export const createPortalSession = async (userId: string): Promise<{ url: string }> => {
  assertBillingEnabled();
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { stripeCustomerId: true },
  });
  if (!user?.stripeCustomerId) throw new ServiceValidationError('No billing account yet.');
  const session = await getStripe().billingPortal.sessions.create({
    customer: user.stripeCustomerId,
    return_url: `${appBaseUrl()}/settings`,
  });
  return { url: session.url };
};

const syncProduct = async (product: Stripe.Product | Stripe.DeletedProduct): Promise<void> => {
  if ('deleted' in product && product.deleted) {
    await prisma.plan.updateMany({
      where: { stripeProductId: product.id },
      data: { isActive: false },
    });
    return;
  }
  const full = product as Stripe.Product;
  if (!isAppPlan(full)) {
    // a product that stopped being a plan stops being offered
    await prisma.plan.updateMany({
      where: { stripeProductId: full.id },
      data: { isActive: false },
    });
    return;
  }
  const data = {
    name: full.name,
    description: full.description ?? null,
    isActive: full.active,
    entitlements: parseEntitlementsMetadata(full.metadata ?? {}),
  };
  await prisma.plan.upsert({
    where: { stripeProductId: full.id },
    create: { stripeProductId: full.id, ...data },
    update: data,
  });
};

/** The local plan id for a Stripe product, syncing the product first if needed. */
const ensurePlanId = async (productId: string): Promise<string | null> => {
  const existing = await prisma.plan.findUnique({ where: { stripeProductId: productId } });
  if (existing) return existing.id;
  await syncProduct(await getStripe().products.retrieve(productId));
  const created = await prisma.plan.findUnique({ where: { stripeProductId: productId } });
  return created?.id ?? null;
};

const syncPrice = async (price: Stripe.Price, deleted = false): Promise<void> => {
  if (deleted || !price.recurring || price.unit_amount === null) {
    await prisma.planPrice.updateMany({
      where: { stripePriceId: price.id },
      data: { isActive: false },
    });
    return;
  }
  const productId = idOf(price.product);
  const planId = productId ? await ensurePlanId(productId) : null;
  if (!planId) return;
  const data = {
    planId,
    unitAmount: price.unit_amount,
    currency: price.currency,
    interval: price.recurring.interval,
    isActive: price.active,
  };
  await prisma.planPrice.upsert({
    where: { stripePriceId: price.id },
    create: { stripePriceId: price.id, ...data },
    update: data,
  });
};

const userIdForSubscription = async (subscription: Stripe.Subscription): Promise<string | null> => {
  const customerId = idOf(subscription.customer);
  if (customerId) {
    const user = await prisma.user.findUnique({
      where: { stripeCustomerId: customerId },
      select: { id: true },
    });
    if (user) return user.id;
  }
  const fromMetadata = subscription.metadata?.userId;
  if (!fromMetadata) return null;
  const user = await prisma.user.findUnique({ where: { id: fromMetadata }, select: { id: true } });
  return user?.id ?? null;
};

/**
 * Re-reads the subscription from Stripe and mirrors it. Fetching instead of
 * trusting the event payload makes out-of-order deliveries harmless.
 */
export const syncSubscription = async (stripeSubscriptionId: string): Promise<void> => {
  const subscription = await getStripe().subscriptions.retrieve(stripeSubscriptionId);
  const userId = await userIdForSubscription(subscription);
  if (!userId) return;

  const item = subscription.items.data[0];
  if (!item) return;
  const stripePriceId = item.price.id;
  let price = await prisma.planPrice.findUnique({ where: { stripePriceId } });
  if (!price) {
    await syncPrice(item.price);
    price = await prisma.planPrice.findUnique({ where: { stripePriceId } });
  }
  if (!price) return;

  const status = STATUS_MAP[subscription.status] ?? 'INCOMPLETE';
  const current = await prisma.subscription.findUnique({ where: { userId } });
  // An old subscription ending must not overwrite a newer, live one.
  if (
    current &&
    current.stripeSubscriptionId !== subscription.id &&
    ENTITLED_STATUSES.includes(current.status) &&
    !ENTITLED_STATUSES.includes(status)
  ) {
    return;
  }

  const data = {
    planId: price.planId,
    stripeSubscriptionId: subscription.id,
    stripePriceId,
    status,
    currentPeriodEnd: new Date(item.current_period_end * 1000),
    cancelAtPeriodEnd: subscription.cancel_at_period_end,
  };
  await prisma.subscription.upsert({
    where: { userId },
    create: { userId, ...data },
    update: data,
  });
};

const dispatch = async (event: Stripe.Event): Promise<void> => {
  switch (event.type) {
    case 'product.created':
    case 'product.updated':
      return syncProduct(event.data.object);
    case 'product.deleted':
      return syncProduct({ ...event.data.object, deleted: true } as Stripe.DeletedProduct);
    case 'price.created':
    case 'price.updated':
      return syncPrice(event.data.object);
    case 'price.deleted':
      return syncPrice(event.data.object, true);
    case 'checkout.session.completed': {
      const subscriptionId = idOf(event.data.object.subscription);
      if (subscriptionId) await syncSubscription(subscriptionId);
      return;
    }
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted':
    case 'customer.subscription.paused':
    case 'customer.subscription.resumed':
      return syncSubscription(event.data.object.id);
    default:
      return;
  }
};

/** Verifies a webhook delivery; throws on a bad signature. */
export const constructStripeEvent = (payload: string, signature: string): Stripe.Event => {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) throw new Error('STRIPE_WEBHOOK_SECRET is not set');
  return getStripe().webhooks.constructEvent(payload, signature, secret);
};

/**
 * Handles a verified event once. The id is recorded after handling, so a
 * failed handler gets Stripe's retry; every handler is an upsert, so a
 * concurrent duplicate is harmless.
 */
export const handleStripeEvent = async (event: Stripe.Event): Promise<void> => {
  const seen = await prisma.stripeEvent.findUnique({ where: { id: event.id } });
  if (seen) return;
  await dispatch(event);
  try {
    await prisma.stripeEvent.create({ data: { id: event.id, type: event.type } });
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')) {
      throw error;
    }
  }
};

/** Pulls every product and price; for first setup and missed webhooks. */
export const syncAllPlans = async (): Promise<{ plans: number; prices: number }> => {
  assertBillingEnabled();
  const stripe = getStripe();
  let plans = 0;
  for await (const product of stripe.products.list({ limit: 100 })) {
    await syncProduct(product);
    if (isAppPlan(product)) plans += 1;
  }
  let prices = 0;
  for await (const price of stripe.prices.list({ limit: 100 })) {
    const productId = idOf(price.product);
    if (!productId || !(await prisma.plan.findUnique({ where: { stripeProductId: productId } }))) {
      continue;
    }
    await syncPrice(price);
    prices += 1;
  }
  return { plans, prices };
};

/**
 * Account deletion: stop billing before the user row (and its Subscription)
 * is gone, so Stripe doesn't keep charging a deleted account.
 */
export const cancelSubscriptionForDeletion = async (userId: string): Promise<void> => {
  if (!isBillingEnabled()) return;
  const subscription = await prisma.subscription.findUnique({ where: { userId } });
  if (!subscription || ['CANCELED', 'INCOMPLETE_EXPIRED'].includes(subscription.status)) return;
  try {
    await getStripe().subscriptions.cancel(subscription.stripeSubscriptionId);
  } catch (error) {
    // already gone in Stripe: nothing left to stop
    if ((error as { code?: string }).code !== 'resource_missing') throw error;
  }
};
