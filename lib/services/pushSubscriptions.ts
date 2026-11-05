import { prisma } from '@/lib/db/prisma';
import { assertFeature } from '@/lib/services/entitlements';
import type { PushTarget } from '@/lib/push/webPush';
import type { SavePushSubscriptionInput } from '@/lib/validators/push';

/** What Settings renders for one registered device. Never carries the push keys. */
export type FrontendPushSubscription = {
  id: string;
  endpoint: string;
  label: string;
  createdAt: string;
  lastUsedAt: string | null;
  expired: boolean;
};

/**
 * Best-effort device label from the subscribe-time user agent — cosmetic only, so
 * an unrecognised UA degrades to "Unknown device" rather than throwing. Browser
 * order matters: Edge and Opera both carry "Chrome" in their UA, and Chrome
 * carries "Safari", so the more specific brand has to be checked first.
 */
export const deviceLabelFromUserAgent = (userAgent: string | null): string => {
  if (!userAgent) {
    return 'Unknown device';
  }

  const ua = userAgent.toLowerCase();

  const browser = ua.includes('edg/')
    ? 'Edge'
    : ua.includes('opr/') || ua.includes('opera')
      ? 'Opera'
      : ua.includes('firefox')
        ? 'Firefox'
        : ua.includes('chrome') || ua.includes('chromium')
          ? 'Chrome'
          : ua.includes('safari')
            ? 'Safari'
            : null;

  const platform = ua.includes('android')
    ? 'Android'
    : ua.includes('iphone') || ua.includes('ipad') || ua.includes('ios')
      ? 'iOS'
      : ua.includes('mac os') || ua.includes('macintosh')
        ? 'macOS'
        : ua.includes('windows')
          ? 'Windows'
          : ua.includes('linux')
            ? 'Linux'
            : null;

  if (browser && platform) {
    return `${browser} on ${platform}`;
  }
  return browser ?? platform ?? 'Unknown device';
};

const toFrontendPushSubscription = (subscription: {
  id: string;
  endpoint: string;
  userAgent: string | null;
  createdAt: Date;
  lastUsedAt: Date | null;
  disabledAt: Date | null;
}): FrontendPushSubscription => ({
  id: subscription.id,
  endpoint: subscription.endpoint,
  label: deviceLabelFromUserAgent(subscription.userAgent),
  createdAt: subscription.createdAt.toISOString(),
  lastUsedAt: subscription.lastUsedAt?.toISOString() ?? null,
  expired: subscription.disabledAt !== null,
});

/**
 * Upserts on `endpoint`, not on (userId, endpoint): a push endpoint identifies a
 * browser registration, so the same browser re-subscribing under a second account
 * reassigns the row instead of colliding on the unique constraint. Re-subscribing
 * also clears `disabledAt`, which is what revives a device previously marked
 * expired — no separate reactivate path.
 */
export const savePushSubscription = async (
  userId: string,
  input: SavePushSubscriptionInput,
  userAgent: string | null,
): Promise<FrontendPushSubscription> => {
  await assertFeature(userId, 'pushReminders');
  const subscription = await prisma.pushSubscription.upsert({
    where: { endpoint: input.endpoint },
    create: {
      userId,
      endpoint: input.endpoint,
      p256dh: input.keys.p256dh,
      auth: input.keys.auth,
      userAgent,
    },
    update: {
      userId,
      p256dh: input.keys.p256dh,
      auth: input.keys.auth,
      userAgent,
      disabledAt: null,
    },
  });

  return toFrontendPushSubscription(subscription);
};

/**
 * `deleteMany` scoped by userId, deliberately: it makes unsubscribing an endpoint
 * that is unknown, already gone, or owned by someone else a silent no-op instead
 * of an error, which is what a client racing two unsubscribes needs.
 */
export const deletePushSubscription = async (
  userId: string,
  endpoint: string,
): Promise<{ removed: number }> => {
  const result = await prisma.pushSubscription.deleteMany({ where: { userId, endpoint } });
  return { removed: result.count };
};

export const listPushSubscriptions = async (
  userId: string,
): Promise<FrontendPushSubscription[]> => {
  const subscriptions = await prisma.pushSubscription.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
  });
  return subscriptions.map(toFrontendPushSubscription);
};

/**
 * The only function that returns the raw push keys, and the only one the send path
 * uses. Never reaches a route response — keeping it separate from
 * `listPushSubscriptions` is what stops a device list from leaking the auth secret.
 */
export const listPushTargets = async (userId: string): Promise<(PushTarget & { id: string })[]> => {
  const subscriptions = await prisma.pushSubscription.findMany({
    where: { userId, disabledAt: null },
    select: { id: true, endpoint: true, p256dh: true, auth: true },
  });
  return subscriptions;
};

export const markPushSubscriptionExpired = async (id: string): Promise<void> => {
  await prisma.pushSubscription.update({ where: { id }, data: { disabledAt: new Date() } });
};

export const touchPushSubscription = async (id: string, now: Date): Promise<void> => {
  await prisma.pushSubscription.update({ where: { id }, data: { lastUsedAt: now } });
};
