import { beforeEach, describe, expect, it, vi } from 'vitest';

const { prismaMock, webPushMock } = vi.hoisted(() => ({
  prismaMock: {
    notificationPreference: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      upsert: vi.fn(),
      updateMany: vi.fn(),
    },
    pushSubscription: { findMany: vi.fn(), update: vi.fn() },
    transaction: { groupBy: vi.fn() },
    importBatch: { groupBy: vi.fn() },
    subscription: { findMany: vi.fn() },
  },
  // The only third-party seam: web-push is transport, so the service is tested
  // without ever touching real crypto or a push service.
  webPushMock: { isPushConfigured: vi.fn(), sendPush: vi.fn() },
}));

vi.mock('@/lib/db/prisma', () => ({ prisma: prismaMock }));
vi.mock('@/lib/push/webPush', () => webPushMock);

const {
  isDueNow,
  hasCadenceFloorElapsed,
  getReminderPreference,
  updateReminderPreference,
  sendDueReminders,
} = await import('@/lib/services/reminders');

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const NOW = new Date('2026-03-10T13:00:00.000Z');
const at = (offsetMs: number): Date => new Date(NOW.getTime() + offsetMs);

const pref = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'pref-1',
  userId: 'user-1',
  enabled: true,
  cadence: 'DAILY',
  lastSentAt: at(-2 * DAY),
  lastEvaluatedAt: null,
  createdAt: at(-30 * DAY),
  ...overrides,
});

const target = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'sub-1',
  endpoint: 'https://fcm.googleapis.com/fcm/send/abc123',
  p256dh: 'BPublicKey',
  auth: 'AuthSecret',
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  webPushMock.isPushConfigured.mockReturnValue(true);
  webPushMock.sendPush.mockResolvedValue({ outcome: 'sent' });
  prismaMock.transaction.groupBy.mockResolvedValue([]);
  prismaMock.importBatch.groupBy.mockResolvedValue([]);
  prismaMock.notificationPreference.updateMany.mockResolvedValue({ count: 0 });
  prismaMock.pushSubscription.update.mockResolvedValue({});
});

describe('isDueNow — cadence floor', () => {
  it('is not due before the cadence floor elapses', () => {
    expect(
      isDueNow(
        { cadence: 'DAILY', lastSentAt: at(-12 * HOUR), createdAt: at(-30 * DAY) },
        null,
        NOW,
      ),
    ).toBe(false);
    expect(
      isDueNow(
        { cadence: 'WEEKLY', lastSentAt: at(-3 * DAY), createdAt: at(-30 * DAY) },
        null,
        NOW,
      ),
    ).toBe(false);
  });

  it('is due exactly at the floor', () => {
    expect(
      isDueNow({ cadence: 'DAILY', lastSentAt: at(-1 * DAY), createdAt: at(-30 * DAY) }, null, NOW),
    ).toBe(true);
    expect(
      isDueNow(
        { cadence: 'WEEKLY', lastSentAt: at(-7 * DAY), createdAt: at(-30 * DAY) },
        null,
        NOW,
      ),
    ).toBe(true);
    expect(
      isDueNow(
        { cadence: 'BIWEEKLY', lastSentAt: at(-14 * DAY), createdAt: at(-60 * DAY) },
        null,
        NOW,
      ),
    ).toBe(true);
    expect(
      isDueNow(
        { cadence: 'MONTHLY', lastSentAt: at(-30 * DAY), createdAt: at(-90 * DAY) },
        null,
        NOW,
      ),
    ).toBe(true);
  });

  it('allows an hour of slack so a daily reminder does not creep later each day', () => {
    // A once-daily cron fires within its scheduled hour, so consecutive ticks can
    // land slightly under 24h apart. Without slack that would skip a whole day.
    expect(
      isDueNow(
        { cadence: 'DAILY', lastSentAt: at(-1 * DAY + 30 * 60 * 1000), createdAt: at(-30 * DAY) },
        null,
        NOW,
      ),
    ).toBe(true);
  });

  it('does not let the slack collapse a cadence into the previous period', () => {
    expect(
      isDueNow(
        { cadence: 'WEEKLY', lastSentAt: at(-7 * DAY + 2 * HOUR), createdAt: at(-30 * DAY) },
        null,
        NOW,
      ),
    ).toBe(false);
  });
});

describe('isDueNow — activity gate', () => {
  it('is not due when activity happened after the window opened', () => {
    const windowStart = at(-5 * DAY);
    expect(
      isDueNow(
        { cadence: 'DAILY', lastSentAt: windowStart, createdAt: at(-30 * DAY) },
        at(-1 * DAY),
        NOW,
      ),
    ).toBe(false);
  });

  it('is not due when activity landed exactly on the window boundary', () => {
    const windowStart = at(-5 * DAY);
    expect(
      isDueNow(
        { cadence: 'DAILY', lastSentAt: windowStart, createdAt: at(-30 * DAY) },
        windowStart,
        NOW,
      ),
    ).toBe(false);
  });

  it('is due when the only activity predates the window', () => {
    expect(
      isDueNow(
        { cadence: 'DAILY', lastSentAt: at(-5 * DAY), createdAt: at(-30 * DAY) },
        at(-6 * DAY),
        NOW,
      ),
    ).toBe(true);
  });

  it('is due for a user who has never logged anything at all', () => {
    expect(
      isDueNow({ cadence: 'DAILY', lastSentAt: at(-5 * DAY), createdAt: at(-30 * DAY) }, null, NOW),
    ).toBe(true);
  });
});

describe('isDueNow — first-ever reminder', () => {
  it('measures the first reminder from createdAt, not from a null lastSentAt', () => {
    // A fresh opt-in must not fire on the very next tick.
    expect(
      isDueNow({ cadence: 'DAILY', lastSentAt: null, createdAt: at(-2 * HOUR) }, null, NOW),
    ).toBe(false);
    expect(
      isDueNow({ cadence: 'DAILY', lastSentAt: null, createdAt: at(-1 * DAY) }, null, NOW),
    ).toBe(true);
  });

  it('gates the first reminder on activity since opt-in', () => {
    expect(
      isDueNow({ cadence: 'DAILY', lastSentAt: null, createdAt: at(-3 * DAY) }, at(-2 * DAY), NOW),
    ).toBe(false);
  });

  it('exposes the cadence floor on its own for the pre-query filter', () => {
    expect(
      hasCadenceFloorElapsed(
        { cadence: 'DAILY', lastSentAt: at(-2 * DAY), createdAt: at(-9 * DAY) },
        NOW,
      ),
    ).toBe(true);
    expect(
      hasCadenceFloorElapsed(
        { cadence: 'MONTHLY', lastSentAt: at(-2 * DAY), createdAt: at(-9 * DAY) },
        NOW,
      ),
    ).toBe(false);
  });
});

describe('getReminderPreference', () => {
  it('returns the opted-out defaults when no row exists', async () => {
    prismaMock.notificationPreference.findUnique.mockResolvedValue(null);

    await expect(getReminderPreference('user-1')).resolves.toEqual({
      enabled: false,
      cadence: 'DAILY',
      lastSentAt: null,
    });
  });

  it('serializes lastSentAt to a string at the service edge', async () => {
    prismaMock.notificationPreference.findUnique.mockResolvedValue(
      pref({ cadence: 'WEEKLY', lastSentAt: at(-2 * DAY) }),
    );

    const result = await getReminderPreference('user-1');

    expect(result).toEqual({
      enabled: true,
      cadence: 'WEEKLY',
      lastSentAt: at(-2 * DAY).toISOString(),
    });
    expect(typeof result.lastSentAt).toBe('string');
  });
});

describe('updateReminderPreference', () => {
  it('creates a row on first opt-in', async () => {
    prismaMock.notificationPreference.findUnique.mockResolvedValue(null);
    prismaMock.notificationPreference.upsert.mockResolvedValue(
      pref({ enabled: true, cadence: 'WEEKLY', lastSentAt: null }),
    );

    await updateReminderPreference('user-1', { enabled: true, cadence: 'WEEKLY' });

    const args = prismaMock.notificationPreference.upsert.mock.calls[0][0];
    expect(args.where).toEqual({ userId: 'user-1' });
    expect(args.create).toEqual({ userId: 'user-1', enabled: true, cadence: 'WEEKLY' });
  });

  it('clears lastSentAt when flipping enabled false → true', async () => {
    // Otherwise a stale timestamp from a previous opt-in period would hold the
    // first reminder behind a cadence floor the user never agreed to.
    prismaMock.notificationPreference.findUnique.mockResolvedValue(
      pref({ enabled: false, lastSentAt: at(-2 * DAY) }),
    );
    prismaMock.notificationPreference.upsert.mockResolvedValue(
      pref({ enabled: true, lastSentAt: null }),
    );

    await updateReminderPreference('user-1', { enabled: true, cadence: 'DAILY' });

    expect(prismaMock.notificationPreference.upsert.mock.calls[0][0].update).toEqual({
      enabled: true,
      cadence: 'DAILY',
      lastSentAt: null,
    });
  });

  it('leaves lastSentAt alone on a cadence-only change', async () => {
    prismaMock.notificationPreference.findUnique.mockResolvedValue(pref({ enabled: true }));
    prismaMock.notificationPreference.upsert.mockResolvedValue(pref({ cadence: 'MONTHLY' }));

    await updateReminderPreference('user-1', { enabled: true, cadence: 'MONTHLY' });

    const update = prismaMock.notificationPreference.upsert.mock.calls[0][0].update;
    expect(update).toEqual({ enabled: true, cadence: 'MONTHLY' });
    expect('lastSentAt' in update).toBe(false);
  });

  it('leaves lastSentAt alone when opting out', async () => {
    prismaMock.notificationPreference.findUnique.mockResolvedValue(pref({ enabled: true }));
    prismaMock.notificationPreference.upsert.mockResolvedValue(pref({ enabled: false }));

    await updateReminderPreference('user-1', { enabled: false, cadence: 'DAILY' });

    expect('lastSentAt' in prismaMock.notificationPreference.upsert.mock.calls[0][0].update).toBe(
      false,
    );
  });
});

describe('sendDueReminders', () => {
  it('skips users whose plan has no push reminders, keeping their preference', async () => {
    vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_123');
    prismaMock.notificationPreference.findMany.mockResolvedValue([
      pref({ userId: 'plus-user' }),
      pref({ id: 'pref-2', userId: 'free-user' }),
    ]);
    prismaMock.subscription.findMany.mockResolvedValue([
      {
        userId: 'plus-user',
        plan: {
          entitlements: {
            limits: { accounts: null },
            historyMonths: null,
            features: {
              trends: true,
              reimbursements: true,
              statementCycles: true,
              pushReminders: true,
            },
          },
        },
      },
    ]);
    prismaMock.pushSubscription.findMany.mockResolvedValue([target()]);

    try {
      const summary = await sendDueReminders(NOW);
      expect(summary.evaluated).toBe(1);
      expect(summary.usersNotified).toBe(1);
      expect(prismaMock.pushSubscription.findMany).toHaveBeenCalledTimes(1);
      expect(prismaMock.notificationPreference.upsert).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('only ever loads enabled preferences — disabled users are never evaluated', async () => {
    prismaMock.notificationPreference.findMany.mockResolvedValue([]);

    const summary = await sendDueReminders(NOW);

    expect(prismaMock.notificationPreference.findMany).toHaveBeenCalledWith({
      where: { enabled: true },
    });
    expect(summary).toEqual({
      evaluated: 0,
      due: 0,
      usersNotified: 0,
      pushesSent: 0,
      pushesFailed: 0,
      subscriptionsExpired: 0,
    });
    expect(webPushMock.sendPush).not.toHaveBeenCalled();
  });

  it('no-ops when push is not configured on the deployment', async () => {
    webPushMock.isPushConfigured.mockReturnValue(false);

    const summary = await sendDueReminders(NOW);

    expect(prismaMock.notificationPreference.findMany).not.toHaveBeenCalled();
    expect(summary.evaluated).toBe(0);
  });

  it('sends to every active device of a due user and stamps lastSentAt', async () => {
    prismaMock.notificationPreference.findMany.mockResolvedValue([pref()]);
    prismaMock.pushSubscription.findMany.mockResolvedValue([
      target({ id: 'sub-1' }),
      target({ id: 'sub-2', endpoint: 'https://fcm.googleapis.com/fcm/send/def456' }),
    ]);

    const summary = await sendDueReminders(NOW);

    expect(webPushMock.sendPush).toHaveBeenCalledTimes(2);
    expect(webPushMock.sendPush.mock.calls[0][1]).toEqual({
      title: 'Track a Loonie',
      body: expect.any(String),
      url: '/dashboard?overlay=add',
    });
    expect(summary.due).toBe(1);
    expect(summary.pushesSent).toBe(2);
    expect(summary.usersNotified).toBe(1);
    expect(prismaMock.notificationPreference.updateMany).toHaveBeenCalledWith({
      where: { userId: { in: ['user-1'] } },
      data: { lastSentAt: NOW },
    });
  });

  it('skips a user with no active devices, recording lastEvaluatedAt only', async () => {
    prismaMock.notificationPreference.findMany.mockResolvedValue([pref()]);
    prismaMock.pushSubscription.findMany.mockResolvedValue([]);

    const summary = await sendDueReminders(NOW);

    expect(webPushMock.sendPush).not.toHaveBeenCalled();
    expect(summary.due).toBe(1);
    expect(summary.usersNotified).toBe(0);

    const calls = prismaMock.notificationPreference.updateMany.mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0][0].data).toEqual({ lastEvaluatedAt: NOW });
  });

  it('stays quiet for a user who has logged a transaction since the last nudge', async () => {
    prismaMock.notificationPreference.findMany.mockResolvedValue([pref()]);
    prismaMock.transaction.groupBy.mockResolvedValue([
      { userId: 'user-1', _max: { createdAt: at(-1 * DAY) } },
    ]);

    const summary = await sendDueReminders(NOW);

    expect(summary.evaluated).toBe(1);
    expect(summary.due).toBe(0);
    expect(webPushMock.sendPush).not.toHaveBeenCalled();
  });

  it('counts a committed import as activity, but ignores an undone one', async () => {
    prismaMock.notificationPreference.findMany.mockResolvedValue([pref()]);
    prismaMock.importBatch.groupBy.mockResolvedValue([
      { userId: 'user-1', _max: { createdAt: at(-1 * DAY) } },
    ]);

    const summary = await sendDueReminders(NOW);

    expect(summary.due).toBe(0);
    // Undone batches are excluded at the query, so an undone import can never
    // read as engagement.
    expect(prismaMock.importBatch.groupBy.mock.calls[0][0].where).toEqual({
      userId: { in: ['user-1'] },
      status: 'ACTIVE',
    });
  });

  it('measures activity on createdAt, not a backdated transaction date', async () => {
    prismaMock.notificationPreference.findMany.mockResolvedValue([pref()]);
    await sendDueReminders(NOW);

    expect(prismaMock.transaction.groupBy.mock.calls[0][0]._max).toEqual({ createdAt: true });
  });

  it('marks lastSentAt when at least one of several devices succeeds', async () => {
    prismaMock.notificationPreference.findMany.mockResolvedValue([pref()]);
    prismaMock.pushSubscription.findMany.mockResolvedValue([
      target({ id: 'sub-1' }),
      target({ id: 'sub-2', endpoint: 'https://fcm.googleapis.com/fcm/send/def456' }),
    ]);
    webPushMock.sendPush
      .mockResolvedValueOnce({ outcome: 'failed', error: 'timeout' })
      .mockResolvedValueOnce({ outcome: 'sent' });

    const summary = await sendDueReminders(NOW);

    expect(summary.pushesSent).toBe(1);
    expect(summary.pushesFailed).toBe(1);
    expect(summary.usersNotified).toBe(1);
    expect(prismaMock.notificationPreference.updateMany).toHaveBeenCalledWith({
      where: { userId: { in: ['user-1'] } },
      data: { lastSentAt: NOW },
    });
  });

  it('leaves lastSentAt untouched when every send fails transiently', async () => {
    prismaMock.notificationPreference.findMany.mockResolvedValue([pref()]);
    prismaMock.pushSubscription.findMany.mockResolvedValue([target()]);
    webPushMock.sendPush.mockResolvedValue({ outcome: 'failed', error: '503 from push service' });

    const summary = await sendDueReminders(NOW);

    expect(summary.pushesFailed).toBe(1);
    expect(summary.usersNotified).toBe(0);
    // Only the bookkeeping update ran; the next daily tick reconsiders this user
    // rather than losing a whole cadence period to a transient outage.
    const calls = prismaMock.notificationPreference.updateMany.mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0][0].data).toEqual({ lastEvaluatedAt: NOW });
  });

  it('expires a subscription the push service reports as gone, without failing the run', async () => {
    prismaMock.notificationPreference.findMany.mockResolvedValue([pref()]);
    prismaMock.pushSubscription.findMany.mockResolvedValue([
      target({ id: 'sub-dead' }),
      target({ id: 'sub-live', endpoint: 'https://fcm.googleapis.com/fcm/send/def456' }),
    ]);
    webPushMock.sendPush
      .mockResolvedValueOnce({ outcome: 'expired' })
      .mockResolvedValueOnce({ outcome: 'sent' });

    const summary = await sendDueReminders(NOW);

    expect(summary.subscriptionsExpired).toBe(1);
    expect(summary.pushesSent).toBe(1);
    expect(summary.pushesFailed).toBe(0);
    expect(prismaMock.pushSubscription.update).toHaveBeenCalledWith({
      where: { id: 'sub-dead' },
      data: { disabledAt: expect.any(Date) },
    });
    expect(prismaMock.pushSubscription.update).toHaveBeenCalledWith({
      where: { id: 'sub-live' },
      data: { lastUsedAt: NOW },
    });
  });

  it('records lastEvaluatedAt for every enabled user, due or not', async () => {
    prismaMock.notificationPreference.findMany.mockResolvedValue([
      pref({ userId: 'user-due' }),
      pref({ userId: 'user-not-due', lastSentAt: at(-1 * HOUR) }),
    ]);
    prismaMock.pushSubscription.findMany.mockResolvedValue([target()]);

    const summary = await sendDueReminders(NOW);

    expect(summary.evaluated).toBe(2);
    expect(summary.due).toBe(1);
    expect(prismaMock.notificationPreference.updateMany).toHaveBeenCalledWith({
      where: { userId: { in: ['user-due', 'user-not-due'] } },
      data: { lastEvaluatedAt: NOW },
    });
  });

  it('only queries activity for users past the cadence floor', async () => {
    prismaMock.notificationPreference.findMany.mockResolvedValue([
      pref({ userId: 'user-due' }),
      pref({ userId: 'user-not-due', lastSentAt: at(-1 * HOUR) }),
    ]);
    prismaMock.pushSubscription.findMany.mockResolvedValue([]);

    await sendDueReminders(NOW);

    expect(prismaMock.transaction.groupBy.mock.calls[0][0].where).toEqual({
      userId: { in: ['user-due'] },
    });
  });

  it('is idempotent across a duplicate same-tick invocation', async () => {
    // First tick sends; the write it performs is what makes the second tick a
    // no-op, so the second run is primed with lastSentAt === NOW.
    prismaMock.notificationPreference.findMany.mockResolvedValueOnce([pref()]);
    prismaMock.pushSubscription.findMany.mockResolvedValue([target()]);

    const first = await sendDueReminders(NOW);
    expect(first.pushesSent).toBe(1);

    prismaMock.notificationPreference.findMany.mockResolvedValueOnce([pref({ lastSentAt: NOW })]);
    const second = await sendDueReminders(NOW);

    expect(second.due).toBe(0);
    expect(second.pushesSent).toBe(0);
    expect(webPushMock.sendPush).toHaveBeenCalledTimes(1);
  });

  it('does not let one user’s devices bleed into another user’s target list', async () => {
    prismaMock.notificationPreference.findMany.mockResolvedValue([
      pref({ userId: 'user-a' }),
      pref({ userId: 'user-b' }),
    ]);
    prismaMock.pushSubscription.findMany
      .mockResolvedValueOnce([target({ id: 'sub-a' })])
      .mockResolvedValueOnce([target({ id: 'sub-b' })]);

    const summary = await sendDueReminders(NOW);

    expect(prismaMock.pushSubscription.findMany.mock.calls[0][0].where.userId).toBe('user-a');
    expect(prismaMock.pushSubscription.findMany.mock.calls[1][0].where.userId).toBe('user-b');
    expect(summary.usersNotified).toBe(2);
  });
});
