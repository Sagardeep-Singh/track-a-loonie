import { getServerAuthSession } from '@/lib/auth/session';
import { SettingsView } from '@/components/settings/settings-view';
import { ScreenHeader } from '@/components/nav/screen-header';
import { userHasPassword } from '@/lib/services/users';
import { getReminderPreference } from '@/lib/services/reminders';
import { listPushSubscriptions } from '@/lib/services/pushSubscriptions';
import { getAiSettings, listAiModels } from '@/lib/services/aiSettings';
import { getBudgetSettings } from '@/lib/services/zeroBased';
import { listAccounts } from '@/lib/services/accounts';

const SettingsPage = async (): Promise<React.ReactElement> => {
  const session = await getServerAuthSession();
  const [
    hasPassword,
    reminderPreference,
    pushDevices,
    aiSettings,
    aiModels,
    budgetSettings,
    accounts,
  ] = await Promise.all([
    userHasPassword(session!.user.id),
    getReminderPreference(session!.user.id),
    listPushSubscriptions(session!.user.id),
    getAiSettings(session!.user.id),
    // Safe to sit in this Promise.all precisely because it never rejects: it
    // returns a discriminated union rather than throwing on a provider blip,
    // so a provider outage cannot take password change, reminders, export and
    // import down with it.
    listAiModels(session!.user.id),
    getBudgetSettings(session!.user.id),
    listAccounts(session!.user.id),
  ]);

  return (
    <div className="max-w-[720px] animate-[fade-up_0.3s_ease-out]">
      <ScreenHeader title="Settings" description="Your account and how Track a Loonie looks." />
      <SettingsView
        email={session!.user.email ?? ''}
        hasPassword={hasPassword}
        googleReauthenticatedAt={session!.user.reauthenticatedAt}
        // Read on the server so a deployment without VAPID keys renders the
        // unavailable copy in the first HTML, not after a client-side check.
        remindersAvailable={Boolean(process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY)}
        reminderPreference={reminderPreference}
        pushDevices={pushDevices}
        aiSettings={aiSettings}
        aiModels={aiModels}
        budgetSettings={budgetSettings}
        accounts={accounts}
      />
    </div>
  );
};

export default SettingsPage;
