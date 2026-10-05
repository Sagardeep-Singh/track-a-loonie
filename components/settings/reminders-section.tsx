'use client';

import { useEffect, useState } from 'react';
import { patchJSON } from '@/lib/api-client';
import { cn } from '@/lib/cn';
import { formatDate } from '@/lib/format';
import { pillOption } from '@/components/settings/pills';
import { PillGroup, PillHighlight } from '@/components/settings/pill-group';
import {
  reconcileRevokedPermission,
  subscribeToPush,
  unsubscribeFromPush,
} from '@/lib/push/client';
import { REMINDER_CADENCES, type ReminderCadence } from '@/lib/validators/reminders';
import type { FrontendReminderPreference } from '@/lib/services/reminders';
import type { FrontendPushSubscription } from '@/lib/services/pushSubscriptions';

const CADENCE_LABELS: Record<ReminderCadence, string> = {
  DAILY: 'Daily',
  WEEKLY: 'Weekly',
  BIWEEKLY: 'Biweekly',
  MONTHLY: 'Monthly',
};

const BLOCKED_NOTICE =
  'Notifications are blocked in your browser — enable them in your browser’s site settings to turn this on.';

export const RemindersSection = ({
  available,
  preference,
  devices: initialDevices,
}: {
  available: boolean;
  preference: FrontendReminderPreference;
  devices: FrontendPushSubscription[];
}): React.ReactElement => {
  const [enabled, setEnabled] = useState(preference.enabled);
  const [cadence, setCadence] = useState<ReminderCadence>(preference.cadence);
  const [devices, setDevices] = useState(initialDevices);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  // Permission drift: the user may have revoked notifications in browser settings
  // since the last visit. Drop this device's registration only — the account-wide
  // toggle stays as it was, or revoking on a laptop would kill the phone too.
  useEffect(() => {
    if (!available) {
      return;
    }
    let cancelled = false;
    void reconcileRevokedPermission().then((dropped) => {
      if (cancelled || !dropped) {
        return;
      }
      setDevices((current) => current.filter((device) => device.endpoint !== dropped));
      setNotice(BLOCKED_NOTICE);
    });
    return () => {
      cancelled = true;
    };
  }, [available]);

  const persist = async (next: {
    enabled: boolean;
    cadence: ReminderCadence;
  }): Promise<boolean> => {
    const response = await patchJSON('/api/settings/reminders', next);
    if (!response.ok) {
      setNotice('Could not save your reminder settings. Try again.');
      return false;
    }
    return true;
  };

  const handleToggle = async (): Promise<void> => {
    if (pending) {
      return;
    }
    setPending(true);
    setNotice(null);

    if (enabled) {
      // Turning off leaves the device registrations in place so switching back on
      // doesn't re-prompt for permission on every device.
      if (await persist({ enabled: false, cadence })) {
        setEnabled(false);
      }
      setPending(false);
      return;
    }

    const result = await subscribeToPush();
    if (result.status === 'denied') {
      setNotice(BLOCKED_NOTICE);
      setPending(false);
      return;
    }
    if (result.status === 'unsupported') {
      setNotice('This browser can’t receive push notifications.');
      setPending(false);
      return;
    }
    if (result.status === 'error') {
      setNotice(result.message);
      setPending(false);
      return;
    }

    if (await persist({ enabled: true, cadence })) {
      setEnabled(true);
      setDevices((current) => [
        result.subscription,
        ...current.filter((device) => device.endpoint !== result.subscription.endpoint),
      ]);
    }
    setPending(false);
  };

  const handleCadence = async (next: ReminderCadence): Promise<void> => {
    if (!enabled || pending || next === cadence) {
      return;
    }
    const previous = cadence;
    setCadence(next);
    setPending(true);
    if (!(await persist({ enabled, cadence: next }))) {
      setCadence(previous);
    }
    setPending(false);
  };

  const handleRemoveDevice = async (endpoint: string): Promise<void> => {
    setNotice(null);
    const removed = await unsubscribeFromPush(endpoint);
    if (!removed) {
      setNotice('Could not remove that device. Try again.');
      return;
    }
    setDevices((current) => current.filter((device) => device.endpoint !== endpoint));
  };

  if (!available) {
    return (
      <div className="border-line bg-paper-raised rounded-2xl border p-5">
        <h2 className="font-display text-[15px] font-semibold">Reminders</h2>
        <p className="text-ink-muted mt-3 text-[13.5px]">
          Reminders aren&rsquo;t available on this deployment.
        </p>
      </div>
    );
  }

  return (
    <div className="border-line bg-paper-raised rounded-2xl border p-5">
      <h2 className="font-display text-[15px] font-semibold">Reminders</h2>

      <div className="ledger-row flex items-center gap-5 py-3.5">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium">Remind me to log expenses</div>
          <div className="text-ink-muted mt-0.5 text-[12.5px]">
            Only nudges you when you haven&rsquo;t logged anything
          </div>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label="Remind me to log expenses"
          disabled={pending}
          onClick={handleToggle}
          className={cn(
            'relative h-7 w-12 shrink-0 rounded-full border transition-colors',
            enabled ? 'bg-iris border-iris' : 'border-line bg-paper-sunk',
            pending && 'opacity-60',
          )}
        >
          <span
            className={cn(
              'bg-paper-raised absolute top-0.5 size-5.5 rounded-full shadow-sm transition-[left]',
              enabled ? 'left-[22px]' : 'left-0.5',
            )}
          />
        </button>
      </div>

      <div className="flex flex-col gap-2.5 py-3.5 sm:flex-row sm:items-center sm:gap-5">
        <div className="min-w-0 flex-1">
          <div className={cn('text-sm font-medium', !enabled && 'text-ink-muted')}>How often</div>
          <div className="text-ink-muted mt-0.5 text-[12.5px]">At most one nudge per period</div>
        </div>
        <PillGroup className="justify-start sm:justify-end">
          {REMINDER_CADENCES.map((option) => (
            <button
              key={option}
              type="button"
              // aria-pressed, not just a color: a pill group is a set of toggle
              // buttons, and screen readers have nothing else to go on.
              aria-pressed={enabled && cadence === option}
              disabled={!enabled || pending}
              onClick={() => handleCadence(option)}
              className={pillOption(enabled && cadence === option, !enabled)}
            >
              <PillHighlight active={enabled && cadence === option} />
              <span className="relative">{CADENCE_LABELS[option]}</span>
            </button>
          ))}
        </PillGroup>
      </div>

      {notice && (
        <p className="bg-rose-soft text-rose mt-1 rounded-lg px-3 py-2 text-[13px]" role="alert">
          {notice}
        </p>
      )}

      {devices.length > 0 && (
        <div className="mt-2">
          <h3 className="text-ink-muted text-[12.5px] font-medium">Devices</h3>
          {devices.map((device) => (
            <div key={device.endpoint} className="flex items-center gap-5 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="text-[13.5px] font-medium">{device.label}</div>
                <div className="text-ink-muted mt-0.5 text-[12.5px]">
                  {device.expired
                    ? 'Expired — re-enable reminders on that device'
                    : device.lastUsedAt
                      ? `Last reminder ${formatDate(device.lastUsedAt)}`
                      : `Added ${formatDate(device.createdAt)}`}
                </div>
              </div>
              <button
                type="button"
                onClick={() => handleRemoveDevice(device.endpoint)}
                className="border-line text-ink shrink-0 rounded-full border px-3.5 py-2 text-[13px] font-medium"
              >
                Remove
              </button>
            </div>
          ))}
        </div>
      )}

      <p className="text-ink-muted mt-3 text-[12.5px]">
        We check once a day, so delivery time varies.
      </p>
    </div>
  );
};
