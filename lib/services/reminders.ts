import { prisma } from '@/lib/db/prisma';
import { assertFeature, filterUsersWithFeature } from '@/lib/services/entitlements';
import { isPushConfigured, sendPush } from '@/lib/push/webPush';
import {
  listPushTargets,
  markPushSubscriptionExpired,
  touchPushSubscription,
} from '@/lib/services/pushSubscriptions';
import type { ReminderCadence, UpdateReminderPreferenceInput } from '@/lib/validators/reminders';

/** Where a tapped notification lands: the add-transaction overlay on the dashboard. */
export const REMINDER_TARGET_URL = '/dashboard?overlay=add';

const REMINDER_TITLE = 'Track a Loonie';
const REMINDER_BODY = 'No spending logged lately — want to catch up?';

/**
 * Cadence as an elapsed-time floor in days, not a calendar boundary: "monthly"
 * means 30 days since the last send, which sidesteps Feb/31st edge cases and
 * costs nothing for a nag reminder (see the plan's known trade-offs).
 */
const CADENCE_DAYS: Record<ReminderCadence, number> = {
  DAILY: 1,
  WEEKLY: 7,
  BIWEEKLY: 14,
  MONTHLY: 30,
};

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Slack subtracted from the cadence floor. Vercel Hobby cron fires *somewhere*
 * within its scheduled hour, so two consecutive daily ticks can be a few minutes
 * under 24h apart; without slack a daily reminder would skip a day and then creep
 * later and later. An hour is comfortably more than the jitter and far less than
 * the shortest cadence.
 */
const CADENCE_SLACK_MS = 60 * 60 * 1000;

/** The shape `isDueNow` reasons about — no Prisma model, no I/O. */
export type ReminderDueInput = {
  cadence: ReminderCadence;
  lastSentAt: Date | null;
  createdAt: Date;
};

export type FrontendReminderPreference = {
  enabled: boolean;
  cadence: ReminderCadence;
  lastSentAt: string | null;
};

export type SendDueRemindersSummary = {
  evaluated: number;
  due: number;
  usersNotified: number;
  pushesSent: number;
  pushesFailed: number;
  subscriptionsExpired: number;
};

/**
 * Start of the window both gates measure against: the last time we nudged, or —
 * for a user who has never been nudged — when they opted in. Using `createdAt` as
 * the fallback is what stops a brand-new opt-in from firing instantly.
 */
const windowStartOf = (pref: ReminderDueInput): Date => pref.lastSentAt ?? pref.createdAt;

/**
 * Gate 1 in isolation: has enough time passed since the last nudge? Split out
 * because `sendDueReminders` applies it before querying activity, so the
 * (expensive) groupBy only covers users who could actually be due.
 */
export const hasCadenceFloorElapsed = (pref: ReminderDueInput, now: Date): boolean =>
  now.getTime() - windowStartOf(pref).getTime() >=
  CADENCE_DAYS[pref.cadence] * DAY_MS - CADENCE_SLACK_MS;

/**
 * Pure, no I/O — the whole "should this user be nudged" decision, and the seam an
 * hourly-cron upgrade would extend (see the plan's cron constraint).
 *
 * 1. Cadence floor: don't nag twice inside one period.
 * 2. Activity gate: if the user logged a transaction or committed an import since
 *    the window opened, they're already engaged. Stay quiet.
 */
export const isDueNow = (
  pref: ReminderDueInput,
  lastActivityAt: Date | null,
  now: Date,
): boolean => {
  if (!hasCadenceFloorElapsed(pref, now)) {
    return false;
  }
  if (lastActivityAt !== null && lastActivityAt.getTime() >= windowStartOf(pref).getTime()) {
    return false;
  }
  return true;
};

/**
 * Always returns one shape so Settings has nothing to branch on: an absent row is
 * the opted-out default, which is how "every existing user starts off" is encoded
 * without a backfill migration.
 */
export const getReminderPreference = async (
  userId: string,
): Promise<FrontendReminderPreference> => {
  const pref = await prisma.notificationPreference.findUnique({ where: { userId } });
  if (!pref) {
    return { enabled: false, cadence: 'DAILY', lastSentAt: null };
  }
  return {
    enabled: pref.enabled,
    cadence: pref.cadence,
    lastSentAt: pref.lastSentAt?.toISOString() ?? null,
  };
};

/**
 * Upsert. Flipping `enabled` off→on clears `lastSentAt`: a stale timestamp from a
 * previous opt-in period would otherwise hold the first reminder hostage to a
 * cadence floor the user never consented to.
 */
export const updateReminderPreference = async (
  userId: string,
  input: UpdateReminderPreferenceInput,
): Promise<FrontendReminderPreference> => {
  if (input.enabled) await assertFeature(userId, 'pushReminders');
  const existing = await prisma.notificationPreference.findUnique({ where: { userId } });
  const reOptingIn = existing !== null && !existing.enabled && input.enabled;

  const pref = await prisma.notificationPreference.upsert({
    where: { userId },
    create: { userId, enabled: input.enabled, cadence: input.cadence },
    update: {
      enabled: input.enabled,
      cadence: input.cadence,
      ...(reOptingIn ? { lastSentAt: null } : {}),
    },
  });

  return {
    enabled: pref.enabled,
    cadence: pref.cadence,
    lastSentAt: pref.lastSentAt?.toISOString() ?? null,
  };
};

/**
 * Most recent "the user opened the app and did something" instant per user.
 *
 * Deliberately `createdAt`, not a transaction's `date`: the gate asks whether the
 * user has engaged recently, and `date` is routinely backdated when catching up on
 * a paper receipt. Undone import batches don't count as engagement either.
 */
const resolveLastActivity = async (userIds: string[]): Promise<Map<string, Date>> => {
  const lastActivity = new Map<string, Date>();
  if (userIds.length === 0) {
    return lastActivity;
  }

  const record = (userId: string, at: Date | null): void => {
    if (!at) {
      return;
    }
    const current = lastActivity.get(userId);
    if (!current || at.getTime() > current.getTime()) {
      lastActivity.set(userId, at);
    }
  };

  const [transactions, imports] = await Promise.all([
    prisma.transaction.groupBy({
      by: ['userId'],
      where: { userId: { in: userIds } },
      _max: { createdAt: true },
    }),
    prisma.importBatch.groupBy({
      by: ['userId'],
      where: { userId: { in: userIds }, status: 'ACTIVE' },
      _max: { createdAt: true },
    }),
  ]);

  for (const row of transactions) {
    record(row.userId, row._max.createdAt);
  }
  for (const row of imports) {
    record(row.userId, row._max.createdAt);
  }

  return lastActivity;
};

/**
 * Runs `worker` over `items` with at most `limit` in flight. Not a serial loop
 * (one slow push service would stall the whole tick) and not an unbounded
 * `Promise.all` (a few hundred devices would open a few hundred sockets at once).
 */
const mapWithConcurrency = async <T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> => {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let cursor = 0;

  const runner = async (): Promise<void> => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      const [settled] = await Promise.allSettled([worker(items[index])]);
      results[index] = settled;
    }
  };

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runner));
  return results;
};

const PUSH_CONCURRENCY = 5;

type SendJob = {
  userId: string;
  subscriptionId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
};

/**
 * The cron tick's entire body of work, so the route handler stays a secret check
 * plus a call. Idempotent within a tick: a user notified at `now` has
 * `lastSentAt === now`, so an immediate second invocation finds them under the
 * cadence floor and sends nothing.
 */
export const sendDueReminders = async (now: Date): Promise<SendDueRemindersSummary> => {
  const summary: SendDueRemindersSummary = {
    evaluated: 0,
    due: 0,
    usersNotified: 0,
    pushesSent: 0,
    pushesFailed: 0,
    subscriptionsExpired: 0,
  };

  // Same optional-feature posture as the Google provider: no keys, no feature —
  // and specifically no half-run that burns everyone's cadence floor on failures.
  if (!isPushConfigured()) {
    return summary;
  }

  const enabledPrefs = await prisma.notificationPreference.findMany({ where: { enabled: true } });
  // a downgraded user keeps their preference and devices, so reminders resume on upgrade
  const entitled = await filterUsersWithFeature(
    enabledPrefs.map((pref) => pref.userId),
    'pushReminders',
  );
  const prefs = enabledPrefs.filter((pref) => entitled.has(pref.userId));
  summary.evaluated = prefs.length;
  if (prefs.length === 0) {
    return summary;
  }

  const pastFloor = prefs.filter((pref) => hasCadenceFloorElapsed(pref, now));
  const lastActivity = await resolveLastActivity(pastFloor.map((pref) => pref.userId));
  const duePrefs = pastFloor.filter((pref) =>
    isDueNow(pref, lastActivity.get(pref.userId) ?? null, now),
  );
  summary.due = duePrefs.length;

  const jobs: SendJob[] = [];
  for (const pref of duePrefs) {
    const targets = await listPushTargets(pref.userId);
    for (const target of targets) {
      jobs.push({
        userId: pref.userId,
        subscriptionId: target.id,
        endpoint: target.endpoint,
        p256dh: target.p256dh,
        auth: target.auth,
      });
    }
  }

  const payload = { title: REMINDER_TITLE, body: REMINDER_BODY, url: REMINDER_TARGET_URL };
  const notifiedUserIds = new Set<string>();

  const settled = await mapWithConcurrency(jobs, PUSH_CONCURRENCY, async (job) => {
    const result = await sendPush(
      { endpoint: job.endpoint, p256dh: job.p256dh, auth: job.auth },
      payload,
    );

    if (result.outcome === 'sent') {
      await touchPushSubscription(job.subscriptionId, now);
    } else if (result.outcome === 'expired') {
      await markPushSubscriptionExpired(job.subscriptionId);
    }

    return { userId: job.userId, outcome: result.outcome };
  });

  for (const entry of settled) {
    if (entry.status !== 'fulfilled') {
      // The push itself never throws; a rejection here means the bookkeeping
      // update did. Count it as a failure rather than letting it end the run.
      summary.pushesFailed += 1;
      continue;
    }
    if (entry.value.outcome === 'sent') {
      summary.pushesSent += 1;
      notifiedUserIds.add(entry.value.userId);
    } else if (entry.value.outcome === 'expired') {
      summary.subscriptionsExpired += 1;
    } else {
      summary.pushesFailed += 1;
    }
  }

  summary.usersNotified = notifiedUserIds.size;

  // Every enabled row was looked at this tick, whether or not it was due — that is
  // exactly what lastEvaluatedAt records, and it's what makes a stalled cron
  // visible without trawling logs.
  await prisma.notificationPreference.updateMany({
    where: { userId: { in: prefs.map((pref) => pref.userId) } },
    data: { lastEvaluatedAt: now },
  });

  // Only an at-least-one-success user advances lastSentAt. An all-transient-failure
  // user keeps their old timestamp so the next daily tick reconsiders them instead
  // of silently swallowing a whole cadence period.
  if (notifiedUserIds.size > 0) {
    await prisma.notificationPreference.updateMany({
      where: { userId: { in: [...notifiedUserIds] } },
      data: { lastSentAt: now },
    });
  }

  return summary;
};
