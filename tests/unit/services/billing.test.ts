import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { UNLIMITED_ENTITLEMENTS } from '@/lib/billing/entitlements';

const { prismaMock, stripeMock } = vi.hoisted(() => ({
  prismaMock: {
    user: { findUnique: vi.fn(), updateMany: vi.fn() },
    plan: { findMany: vi.fn(), findUnique: vi.fn(), upsert: vi.fn(), updateMany: vi.fn() },
    planPrice: { findFirst: vi.fn(), findUnique: vi.fn(), upsert: vi.fn(), updateMany: vi.fn() },
    subscription: { findFirst: vi.fn(), findUnique: vi.fn(), upsert: vi.fn() },
    stripeEvent: { findUnique: vi.fn(), create: vi.fn() },
  },
  stripeMock: {
    customers: { create: vi.fn() },
    checkout: { sessions: { create: vi.fn(), retrieve: vi.fn() } },
    billingPortal: { sessions: { create: vi.fn() } },
    subscriptions: { retrieve: vi.fn(), cancel: vi.fn() },
    products: { retrieve: vi.fn() },
  },
}));

vi.mock('@/lib/db/prisma', () => ({ prisma: prismaMock }));
vi.mock('@/lib/billing/stripe', () => ({
  isBillingEnabled: () => !!process.env.STRIPE_SECRET_KEY,
  getStripe: () => stripeMock,
}));

const {
  cancelSubscriptionForDeletion,
  createCheckoutSession,
  getBillingSummary,
  getCheckoutResult,
  handleStripeEvent,
  listPlans,
  syncSubscription,
} = await import('@/lib/services/billing');
const { ServiceValidationError } = await import('@/lib/services/common');

const stripeSubscription = (overrides: Record<string, unknown> = {}) => ({
  id: 'sub_1',
  status: 'active',
  customer: 'cus_1',
  metadata: { userId: 'user-1' },
  cancel_at_period_end: false,
  items: { data: [{ price: { id: 'price_plus' }, current_period_end: 1_800_000_000 }] },
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_123');
  vi.stubEnv('NEXTAUTH_URL', 'https://app.example');
  prismaMock.subscription.findFirst.mockResolvedValue(null);
  prismaMock.subscription.findUnique.mockResolvedValue(null);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('listPlans', () => {
  it('returns active plans with prices, cheapest first, dropping plans with no price', async () => {
    prismaMock.plan.findMany.mockResolvedValue([
      {
        id: 'pro',
        name: 'Pro',
        description: null,
        entitlements: UNLIMITED_ENTITLEMENTS,
        prices: [
          { stripePriceId: 'price_pro', unitAmount: 900, currency: 'cad', interval: 'month' },
        ],
      },
      { id: 'empty', name: 'Empty', description: null, entitlements: {}, prices: [] },
      {
        id: 'plus',
        name: 'Plus',
        description: 'Every account',
        entitlements: UNLIMITED_ENTITLEMENTS,
        prices: [
          { stripePriceId: 'price_plus', unitAmount: 400, currency: 'cad', interval: 'month' },
        ],
      },
    ]);
    const plans = await listPlans();
    expect(plans.map((p) => p.id)).toEqual(['plus', 'pro']);
    expect(plans[0].prices[0]).toEqual({
      id: 'price_plus',
      unitAmount: 400,
      currency: 'cad',
      interval: 'month',
    });
  });
});

describe('getBillingSummary', () => {
  it('reports Free for a user with a canceled subscription', async () => {
    prismaMock.user.findUnique.mockResolvedValue({
      stripeCustomerId: 'cus_1',
      subscription: {
        status: 'CANCELED',
        currentPeriodEnd: new Date('2026-10-01'),
        cancelAtPeriodEnd: false,
        plan: { name: 'Plus' },
      },
    });
    const summary = await getBillingSummary('user-1');
    expect(summary).toMatchObject({
      enabled: true,
      planName: 'Free',
      isPaid: false,
      currentPeriodEnd: null,
      canManage: true,
    });
  });

  it('reports the plan and renewal for an active one', async () => {
    prismaMock.subscription.findFirst.mockResolvedValue({
      plan: { entitlements: UNLIMITED_ENTITLEMENTS },
    });
    prismaMock.user.findUnique.mockResolvedValue({
      stripeCustomerId: 'cus_1',
      subscription: {
        status: 'ACTIVE',
        currentPeriodEnd: new Date('2026-12-05T00:00:00Z'),
        cancelAtPeriodEnd: true,
        plan: { name: 'Plus' },
      },
    });
    expect(await getBillingSummary('user-1')).toMatchObject({
      planName: 'Plus',
      isPaid: true,
      currentPeriodEnd: '2026-12-05T00:00:00.000Z',
      cancelAtPeriodEnd: true,
    });
  });
});

describe('createCheckoutSession', () => {
  beforeEach(() => {
    prismaMock.planPrice.findFirst.mockResolvedValue({ stripePriceId: 'price_plus' });
    stripeMock.checkout.sessions.create.mockResolvedValue({ client_secret: 'cs_secret' });
  });

  it('refuses when billing is off', async () => {
    vi.stubEnv('STRIPE_SECRET_KEY', '');
    await expect(createCheckoutSession('user-1', 'price_plus')).rejects.toBeInstanceOf(
      ServiceValidationError,
    );
  });

  it('refuses an unknown or inactive price', async () => {
    prismaMock.planPrice.findFirst.mockResolvedValue(null);
    await expect(createCheckoutSession('user-1', 'price_nope')).rejects.toThrow(
      'That plan is not available.',
    );
  });

  it('refuses when the user already has a live subscription', async () => {
    prismaMock.subscription.findFirst.mockResolvedValue({ id: 'existing' });
    await expect(createCheckoutSession('user-1', 'price_plus')).rejects.toThrow(
      /already have a subscription/,
    );
    expect(stripeMock.checkout.sessions.create).not.toHaveBeenCalled();
  });

  it('reuses the stored customer and starts an embedded subscription checkout', async () => {
    prismaMock.user.findUnique.mockResolvedValue({
      email: 'a@example.com',
      name: null,
      stripeCustomerId: 'cus_existing',
    });
    expect(await createCheckoutSession('user-1', 'price_plus')).toEqual({
      clientSecret: 'cs_secret',
    });
    expect(stripeMock.customers.create).not.toHaveBeenCalled();
    expect(stripeMock.checkout.sessions.create).toHaveBeenCalledWith({
      mode: 'subscription',
      ui_mode: 'embedded_page',
      customer: 'cus_existing',
      client_reference_id: 'user-1',
      line_items: [{ price: 'price_plus', quantity: 1 }],
      subscription_data: { metadata: { userId: 'user-1' } },
      return_url: 'https://app.example/upgrade/complete?session_id={CHECKOUT_SESSION_ID}',
    });
  });

  it('creates and stores a customer the first time', async () => {
    prismaMock.user.findUnique
      .mockResolvedValueOnce({ email: 'a@example.com', name: 'A', stripeCustomerId: null })
      .mockResolvedValueOnce({ stripeCustomerId: 'cus_new' });
    stripeMock.customers.create.mockResolvedValue({ id: 'cus_new' });
    await createCheckoutSession('user-1', 'price_plus');
    expect(stripeMock.customers.create).toHaveBeenCalledWith({
      email: 'a@example.com',
      name: 'A',
      metadata: { userId: 'user-1' },
    });
    expect(prismaMock.user.updateMany).toHaveBeenCalledWith({
      where: { id: 'user-1', stripeCustomerId: null },
      data: { stripeCustomerId: 'cus_new' },
    });
    expect(stripeMock.checkout.sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({ customer: 'cus_new' }),
    );
  });
});

describe('getCheckoutResult', () => {
  it("rejects another user's session", async () => {
    stripeMock.checkout.sessions.retrieve.mockResolvedValue({
      client_reference_id: 'someone-else',
      status: 'complete',
    });
    await expect(getCheckoutResult('user-1', 'cs_1')).rejects.toBeInstanceOf(
      ServiceValidationError,
    );
  });

  it('turns an unknown session id into a validation error', async () => {
    stripeMock.checkout.sessions.retrieve.mockRejectedValue({
      type: 'StripeInvalidRequestError',
    });
    await expect(getCheckoutResult('user-1', 'cs_bad')).rejects.toBeInstanceOf(
      ServiceValidationError,
    );
  });

  it('syncs the subscription right away when complete', async () => {
    stripeMock.checkout.sessions.retrieve.mockResolvedValue({
      client_reference_id: 'user-1',
      status: 'complete',
      subscription: 'sub_1',
    });
    stripeMock.subscriptions.retrieve.mockResolvedValue(stripeSubscription());
    prismaMock.user.findUnique.mockResolvedValue({ id: 'user-1' });
    prismaMock.planPrice.findUnique.mockResolvedValue({ planId: 'plan-plus' });

    expect(await getCheckoutResult('user-1', 'cs_1')).toEqual({ status: 'complete' });
    expect(prismaMock.subscription.upsert).toHaveBeenCalledTimes(1);
  });

  it('reports an open session without syncing', async () => {
    stripeMock.checkout.sessions.retrieve.mockResolvedValue({
      client_reference_id: 'user-1',
      status: 'open',
    });
    expect(await getCheckoutResult('user-1', 'cs_1')).toEqual({ status: 'open' });
    expect(stripeMock.subscriptions.retrieve).not.toHaveBeenCalled();
  });
});

describe('syncSubscription', () => {
  beforeEach(() => {
    prismaMock.user.findUnique.mockResolvedValue({ id: 'user-1' });
    prismaMock.planPrice.findUnique.mockResolvedValue({ planId: 'plan-plus' });
  });

  it('mirrors status, price and period end from Stripe', async () => {
    stripeMock.subscriptions.retrieve.mockResolvedValue(
      stripeSubscription({ status: 'past_due', cancel_at_period_end: true }),
    );
    await syncSubscription('sub_1');
    const data = {
      planId: 'plan-plus',
      stripeSubscriptionId: 'sub_1',
      stripePriceId: 'price_plus',
      status: 'PAST_DUE',
      currentPeriodEnd: new Date(1_800_000_000 * 1000),
      cancelAtPeriodEnd: true,
    };
    expect(prismaMock.subscription.upsert).toHaveBeenCalledWith({
      where: { userId: 'user-1' },
      create: { userId: 'user-1', ...data },
      update: data,
    });
  });

  it('does nothing for a customer it does not know', async () => {
    prismaMock.user.findUnique.mockResolvedValue(null);
    stripeMock.subscriptions.retrieve.mockResolvedValue(stripeSubscription({ metadata: {} }));
    await syncSubscription('sub_1');
    expect(prismaMock.subscription.upsert).not.toHaveBeenCalled();
  });

  it('does not let an old subscription ending overwrite a newer live one', async () => {
    prismaMock.subscription.findUnique.mockResolvedValue({
      stripeSubscriptionId: 'sub_new',
      status: 'ACTIVE',
    });
    stripeMock.subscriptions.retrieve.mockResolvedValue(
      stripeSubscription({ id: 'sub_old', status: 'canceled' }),
    );
    await syncSubscription('sub_old');
    expect(prismaMock.subscription.upsert).not.toHaveBeenCalled();
  });
});

describe('handleStripeEvent', () => {
  it('skips an event it already handled', async () => {
    prismaMock.stripeEvent.findUnique.mockResolvedValue({ id: 'evt_1' });
    await handleStripeEvent({ id: 'evt_1', type: 'product.updated' } as never);
    expect(prismaMock.plan.upsert).not.toHaveBeenCalled();
    expect(prismaMock.stripeEvent.create).not.toHaveBeenCalled();
  });

  it('syncs a plan product and records the event', async () => {
    prismaMock.stripeEvent.findUnique.mockResolvedValue(null);
    await handleStripeEvent({
      id: 'evt_2',
      type: 'product.updated',
      data: {
        object: {
          id: 'prod_plus',
          name: 'Plus',
          description: 'Every account',
          active: true,
          metadata: { plan: 'true', limit_accounts: 'unlimited', feature_trends: 'true' },
        },
      },
    } as never);
    expect(prismaMock.plan.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { stripeProductId: 'prod_plus' },
        update: expect.objectContaining({
          name: 'Plus',
          isActive: true,
          entitlements: expect.objectContaining({
            limits: { accounts: null },
            historyMonths: 12,
          }),
        }),
      }),
    );
    expect(prismaMock.stripeEvent.create).toHaveBeenCalledWith({
      data: { id: 'evt_2', type: 'product.updated' },
    });
  });

  it('ignores products that are not app plans', async () => {
    prismaMock.stripeEvent.findUnique.mockResolvedValue(null);
    await handleStripeEvent({
      id: 'evt_3',
      type: 'product.created',
      data: { object: { id: 'prod_mug', name: 'Mug', active: true, metadata: {} } },
    } as never);
    expect(prismaMock.plan.upsert).not.toHaveBeenCalled();
    expect(prismaMock.plan.updateMany).toHaveBeenCalledWith({
      where: { stripeProductId: 'prod_mug' },
      data: { isActive: false },
    });
  });

  it('treats a concurrent duplicate insert as already handled', async () => {
    prismaMock.stripeEvent.findUnique.mockResolvedValue(null);
    prismaMock.stripeEvent.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('duplicate', {
        code: 'P2002',
        clientVersion: 'test',
      }),
    );
    await expect(
      handleStripeEvent({ id: 'evt_4', type: 'invoice.paid', data: { object: {} } } as never),
    ).resolves.toBeUndefined();
  });

  it('does not record the event when handling fails, so Stripe retries it', async () => {
    prismaMock.stripeEvent.findUnique.mockResolvedValue(null);
    stripeMock.subscriptions.retrieve.mockRejectedValue(new Error('stripe down'));
    await expect(
      handleStripeEvent({
        id: 'evt_5',
        type: 'customer.subscription.updated',
        data: { object: { id: 'sub_1' } },
      } as never),
    ).rejects.toThrow('stripe down');
    expect(prismaMock.stripeEvent.create).not.toHaveBeenCalled();
  });
});

describe('cancelSubscriptionForDeletion', () => {
  it('cancels a live subscription', async () => {
    prismaMock.subscription.findUnique.mockResolvedValue({
      stripeSubscriptionId: 'sub_1',
      status: 'ACTIVE',
    });
    await cancelSubscriptionForDeletion('user-1');
    expect(stripeMock.subscriptions.cancel).toHaveBeenCalledWith('sub_1');
  });

  it('skips an already canceled one and tolerates one Stripe no longer has', async () => {
    prismaMock.subscription.findUnique.mockResolvedValue({
      stripeSubscriptionId: 'sub_1',
      status: 'CANCELED',
    });
    await cancelSubscriptionForDeletion('user-1');
    expect(stripeMock.subscriptions.cancel).not.toHaveBeenCalled();

    prismaMock.subscription.findUnique.mockResolvedValue({
      stripeSubscriptionId: 'sub_2',
      status: 'PAST_DUE',
    });
    stripeMock.subscriptions.cancel.mockRejectedValue({ code: 'resource_missing' });
    await expect(cancelSubscriptionForDeletion('user-1')).resolves.toBeUndefined();
  });

  it('does nothing when billing is off', async () => {
    vi.stubEnv('STRIPE_SECRET_KEY', '');
    await cancelSubscriptionForDeletion('user-1');
    expect(prismaMock.subscription.findUnique).not.toHaveBeenCalled();
  });
});
