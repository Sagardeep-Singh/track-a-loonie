import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UNLIMITED_ENTITLEMENTS } from '@/lib/billing/entitlements';

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    subscription: { findFirst: vi.fn(), findMany: vi.fn() },
    account: { count: vi.fn() },
  },
}));

vi.mock('@/lib/db/prisma', () => ({ prisma: prismaMock }));

const {
  assertCanCreate,
  assertFeature,
  assertTotalWithinLimit,
  clampMonthToHistory,
  clampRangeToHistory,
  filterUsersWithFeature,
  getEntitlements,
  getHistoryFloor,
} = await import('@/lib/services/entitlements');
const { PlanRestrictionError, ServiceValidationError } = await import('@/lib/services/common');

const plusSubscription = { plan: { entitlements: UNLIMITED_ENTITLEMENTS } };

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_123');
  prismaMock.subscription.findFirst.mockResolvedValue(null);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('getEntitlements', () => {
  it('is unlimited without touching the database when billing is off', async () => {
    vi.stubEnv('STRIPE_SECRET_KEY', '');
    expect(await getEntitlements('user-1')).toEqual(UNLIMITED_ENTITLEMENTS);
    expect(prismaMock.subscription.findFirst).not.toHaveBeenCalled();
  });

  it('is Free with no entitled subscription', async () => {
    const result = await getEntitlements('user-1');
    expect(result.limits.accounts).toBe(2);
    expect(result.features.trends).toBe(false);
    expect(prismaMock.subscription.findFirst).toHaveBeenCalledWith({
      where: { userId: 'user-1', status: { in: ['ACTIVE', 'TRIALING', 'PAST_DUE'] } },
      select: { plan: { select: { entitlements: true } } },
    });
  });

  it("is the plan's entitlements with an entitled subscription", async () => {
    prismaMock.subscription.findFirst.mockResolvedValue(plusSubscription);
    expect(await getEntitlements('user-1')).toEqual(UNLIMITED_ENTITLEMENTS);
  });
});

describe('assertCanCreate', () => {
  it('allows the second account on Free', async () => {
    prismaMock.account.count.mockResolvedValue(1);
    await expect(assertCanCreate('user-1', 'accounts')).resolves.toBeUndefined();
  });

  it('refuses the third account on Free with a plan limit error', async () => {
    prismaMock.account.count.mockResolvedValue(2);
    const error = await assertCanCreate('user-1', 'accounts').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PlanRestrictionError);
    expect(error).toBeInstanceOf(ServiceValidationError);
    expect(error).toMatchObject({ kind: 'limit', key: 'accounts' });
    expect((error as Error).message).toMatch(/2 accounts/);
  });

  it('refuses when already over the limit after a downgrade', async () => {
    prismaMock.account.count.mockResolvedValue(6);
    await expect(assertCanCreate('user-1', 'accounts')).rejects.toBeInstanceOf(
      PlanRestrictionError,
    );
  });

  it('skips counting on an unlimited plan', async () => {
    prismaMock.subscription.findFirst.mockResolvedValue(plusSubscription);
    await expect(assertCanCreate('user-1', 'accounts')).resolves.toBeUndefined();
    expect(prismaMock.account.count).not.toHaveBeenCalled();
  });
});

describe('assertTotalWithinLimit', () => {
  it('allows exactly the limit and refuses one more', async () => {
    await expect(assertTotalWithinLimit('user-1', 'accounts', 2)).resolves.toBeUndefined();
    await expect(assertTotalWithinLimit('user-1', 'accounts', 3)).rejects.toBeInstanceOf(
      PlanRestrictionError,
    );
  });
});

describe('assertFeature', () => {
  it('refuses a Plus feature on Free', async () => {
    await expect(assertFeature('user-1', 'trends')).rejects.toMatchObject({
      kind: 'feature',
      key: 'trends',
    });
  });

  it('allows it on Plus', async () => {
    prismaMock.subscription.findFirst.mockResolvedValue(plusSubscription);
    await expect(assertFeature('user-1', 'trends')).resolves.toBeUndefined();
  });
});

describe('history window', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-05T12:00:00Z'));
  });

  it('starts the window 11 months before the current one on Free', async () => {
    expect((await getHistoryFloor('user-1'))?.toISOString()).toBe('2025-12-01T00:00:00.000Z');
  });

  it('moves an older month up to the oldest visible one', async () => {
    expect(await clampMonthToHistory('user-1', 202401)).toBe(202512);
    expect(await clampMonthToHistory('user-1', 202603)).toBe(202603);
  });

  it('moves the start of a range up, and fills in an open start', async () => {
    expect(await clampRangeToHistory('user-1', { from: null, to: null })).toEqual({
      from: '2025-12-01',
      to: null,
    });
    expect(await clampRangeToHistory('user-1', { from: '2024-01-01', to: '2026-02-01' })).toEqual({
      from: '2025-12-01',
      to: '2026-02-01',
    });
    expect(await clampRangeToHistory('user-1', { from: '2026-03-01', to: null })).toEqual({
      from: '2026-03-01',
      to: null,
    });
  });

  it('leaves everything alone on Plus', async () => {
    prismaMock.subscription.findFirst.mockResolvedValue(plusSubscription);
    expect(await getHistoryFloor('user-1')).toBeNull();
    expect(await clampMonthToHistory('user-1', 201901)).toBe(201901);
    expect(await clampRangeToHistory('user-1', { from: null, to: null })).toEqual({
      from: null,
      to: null,
    });
  });
});

describe('filterUsersWithFeature', () => {
  it('keeps only users whose plan has the feature', async () => {
    prismaMock.subscription.findMany.mockResolvedValue([
      { userId: 'plus', plan: { entitlements: UNLIMITED_ENTITLEMENTS } },
      { userId: 'broken', plan: { entitlements: {} } },
    ]);
    const result = await filterUsersWithFeature(['plus', 'free', 'broken'], 'pushReminders');
    expect([...result]).toEqual(['plus']);
  });

  it('keeps everyone when billing is off', async () => {
    vi.stubEnv('STRIPE_SECRET_KEY', '');
    const result = await filterUsersWithFeature(['a', 'b'], 'pushReminders');
    expect([...result]).toEqual(['a', 'b']);
    expect(prismaMock.subscription.findMany).not.toHaveBeenCalled();
  });
});
