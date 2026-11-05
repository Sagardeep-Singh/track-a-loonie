import type { SubscriptionStatus } from '@prisma/client';
import { toDateKey } from '@/lib/date';
import { prisma } from '@/lib/db/prisma';
import {
  FEATURE_LABELS,
  FREE_ENTITLEMENTS,
  UNLIMITED_ENTITLEMENTS,
  historyFloorMonth,
  monthStartDate,
  readStoredEntitlements,
  type Entitlements,
  type FeatureKey,
  type LimitKey,
} from '@/lib/billing/entitlements';
import { isBillingEnabled } from '@/lib/billing/stripe';
import { PlanRestrictionError } from '@/lib/services/common';
import type { DateRange } from '@/lib/period-selection';

/**
 * Statuses that keep the paid plan. `past_due` stays entitled while Stripe
 * retries the card; `unpaid`, `canceled` and the incomplete states drop to
 * Free. Cancelling in the portal keeps `active` until the period ends.
 */
export const ENTITLED_STATUSES: SubscriptionStatus[] = ['ACTIVE', 'TRIALING', 'PAST_DUE'];

export const getEntitlements = async (userId: string): Promise<Entitlements> => {
  if (!isBillingEnabled()) return UNLIMITED_ENTITLEMENTS;
  const subscription = await prisma.subscription.findFirst({
    where: { userId, status: { in: ENTITLED_STATUSES } },
    select: { plan: { select: { entitlements: true } } },
  });
  return subscription ? readStoredEntitlements(subscription.plan.entitlements) : FREE_ENTITLEMENTS;
};

const LIMIT_MESSAGES: Record<LimitKey, (limit: number) => string> = {
  accounts: (limit) =>
    `Your plan includes ${limit} accounts. Upgrade to Plus for unlimited accounts.`,
};

const countFor = (userId: string, key: LimitKey): Promise<number> => {
  switch (key) {
    case 'accounts':
      return prisma.account.count({ where: { userId } });
  }
};

/** Refuses when the user would end up with more than their plan's limit. */
export const assertTotalWithinLimit = async (
  userId: string,
  key: LimitKey,
  total: number,
): Promise<void> => {
  const limit = (await getEntitlements(userId)).limits[key];
  if (limit !== null && total > limit) {
    throw new PlanRestrictionError(LIMIT_MESSAGES[key](limit), 'limit', key);
  }
};

/**
 * Refuses one more create past a count limit. Count and insert aren't
 * atomic: two parallel creates can land one over the limit, which is
 * accepted rather than locked.
 */
export const assertCanCreate = async (userId: string, key: LimitKey): Promise<void> => {
  if ((await getEntitlements(userId)).limits[key] === null) return;
  await assertTotalWithinLimit(userId, key, (await countFor(userId, key)) + 1);
};

export const featureRestriction = (key: FeatureKey): PlanRestrictionError =>
  new PlanRestrictionError(`${FEATURE_LABELS[key]} are part of Plus.`, 'feature', key);

export const hasFeature = async (userId: string, key: FeatureKey): Promise<boolean> =>
  (await getEntitlements(userId)).features[key];

export const assertFeature = async (userId: string, key: FeatureKey): Promise<void> => {
  if (!(await hasFeature(userId, key))) throw featureRestriction(key);
};

/** `YYYYMM` of the oldest month the user can browse, or null for all history. */
export const getHistoryFloorMonth = async (
  userId: string,
  now: Date = new Date(),
): Promise<number | null> => historyFloorMonth(await getEntitlements(userId), now);

/** First instant the user can browse, or null for all history. */
export const getHistoryFloor = async (userId: string, now?: Date): Promise<Date | null> => {
  const month = await getHistoryFloorMonth(userId, now);
  return month === null ? null : monthStartDate(month);
};

/** A requested month moved forward to the oldest visible one when it's older. */
export const clampMonthToHistory = async (userId: string, month: number): Promise<number> => {
  const floor = await getHistoryFloorMonth(userId);
  return floor !== null && month < floor ? floor : month;
};

/** The subset of `userIds` whose plan includes `key`; one query for a batch job. */
export const filterUsersWithFeature = async (
  userIds: string[],
  key: FeatureKey,
): Promise<Set<string>> => {
  if (!isBillingEnabled() || FREE_ENTITLEMENTS.features[key]) return new Set(userIds);
  if (userIds.length === 0) return new Set();
  const subscriptions = await prisma.subscription.findMany({
    where: { userId: { in: userIds }, status: { in: ENTITLED_STATUSES } },
    select: { userId: true, plan: { select: { entitlements: true } } },
  });
  return new Set(
    subscriptions
      .filter((s) => readStoredEntitlements(s.plan.entitlements).features[key])
      .map((s) => s.userId),
  );
};

/**
 * A `yyyy-mm-dd` range with its start moved up to the history floor. Only the
 * start moves: a range that ends before the floor comes back empty, which is
 * what an over-limit month should show.
 */
export const clampRangeToHistory = async (userId: string, range: DateRange): Promise<DateRange> => {
  const floor = await getHistoryFloor(userId);
  if (!floor) return range;
  const floorKey = toDateKey(floor);
  return { ...range, from: !range.from || range.from < floorKey ? floorKey : range.from };
};
