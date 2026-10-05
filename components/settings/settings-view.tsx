'use client';

import { useSyncExternalStore } from 'react';
import { ChangePasswordForm } from '@/components/settings/change-password-form';
import { RemindersSection } from '@/components/settings/reminders-section';
import { AiCategorizationSection } from '@/components/settings/ai-categorization-section';
import { BudgetingSection } from '@/components/settings/budgeting-section';
import { ExportDataCard } from '@/components/settings/export-data-card';
import { ImportDataCard } from '@/components/settings/import-data-card';
import { DeleteAccountCard } from '@/components/settings/delete-account-card';
import { pillGroup, pillOption } from '@/components/settings/pills';
import type { FrontendReminderPreference } from '@/lib/services/reminders';
import type { FrontendPushSubscription } from '@/lib/services/pushSubscriptions';
import type { AiModelsResult, FrontendAiSettings } from '@/lib/services/aiSettings';
import type { FrontendAccount } from '@/lib/services/accounts';
import type { FrontendBudgetSettings } from '@/lib/services/zeroBased';
import {
  APPEARANCES,
  PALETTES,
  getAppearanceServerSnapshot,
  getAppearanceSnapshot,
  getPaletteServerSnapshot,
  getPaletteSnapshot,
  savePreferences,
  subscribeToPreferences,
  type Appearance,
  type Palette,
} from '@/lib/preferences';

const PALETTE_LABELS: Record<Palette, string> = { clay: 'Clay', cobalt: 'Cobalt', iris: 'Iris' };
const APPEARANCE_LABELS: Record<Appearance, string> = {
  system: 'System',
  light: 'Light',
  dark: 'Dark',
};

export const SettingsView = ({
  email,
  hasPassword,
  googleReauthenticatedAt,
  remindersAvailable,
  reminderPreference,
  pushDevices,
  aiSettings,
  aiModels,
  budgetSettings,
  accounts,
}: {
  email: string;
  hasPassword: boolean;
  googleReauthenticatedAt: number | null;
  remindersAvailable: boolean;
  reminderPreference: FrontendReminderPreference;
  pushDevices: FrontendPushSubscription[];
  aiSettings: FrontendAiSettings;
  aiModels: AiModelsResult;
  budgetSettings: FrontendBudgetSettings;
  accounts: FrontendAccount[];
}): React.ReactElement => {
  const palette = useSyncExternalStore(
    subscribeToPreferences,
    getPaletteSnapshot,
    getPaletteServerSnapshot,
  );
  const appearance = useSyncExternalStore(
    subscribeToPreferences,
    getAppearanceSnapshot,
    getAppearanceServerSnapshot,
  );

  return (
    <div className="mt-6.5 flex flex-col gap-4">
      <div className="border-line bg-paper-raised rounded-2xl border p-5">
        <h2 className="font-display text-[15px] font-semibold">Account</h2>
        <div className="ledger-row flex items-center gap-5 py-3.5">
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium">Email</div>
            <div className="text-ink-muted mt-0.5 text-[12.5px]">Signed in as</div>
          </div>
          <span className="text-ink-muted shrink-0 rounded-full px-3.5 py-2 text-[13px]">
            {email}
          </span>
        </div>
      </div>

      <div className="border-line bg-paper-raised rounded-2xl border p-5">
        <h2 className="font-display text-[15px] font-semibold">Preferences</h2>
        <div className="ledger-row flex items-center gap-5 py-3.5">
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium">Accent</div>
            <div className="text-ink-muted mt-0.5 text-[12.5px]">
              Track a Loonie&rsquo;s color palette
            </div>
          </div>
          <div className={pillGroup}>
            {PALETTES.map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => savePreferences(p, appearance)}
                className={pillOption(palette === p)}
              >
                {PALETTE_LABELS[p]}
              </button>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-5 py-3.5">
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium">Appearance</div>
            <div className="text-ink-muted mt-0.5 text-[12.5px]">
              Light, dark, or match your device
            </div>
          </div>
          <div className={pillGroup}>
            {APPEARANCES.map((a) => (
              <button
                key={a}
                type="button"
                onClick={() => savePreferences(palette, a)}
                className={pillOption(appearance === a)}
              >
                {APPEARANCE_LABELS[a]}
              </button>
            ))}
          </div>
        </div>
      </div>

      <BudgetingSection settings={budgetSettings} accounts={accounts} />

      <RemindersSection
        available={remindersAvailable}
        preference={reminderPreference}
        devices={pushDevices}
      />

      <AiCategorizationSection settings={aiSettings} models={aiModels} />

      <div className="border-line bg-paper-raised rounded-2xl border p-5">
        <h2 className="font-display text-[15px] font-semibold">Change password</h2>
        {hasPassword ? (
          <ChangePasswordForm />
        ) : (
          <p className="text-ink-muted mt-3 text-[13.5px]">
            Your account signed in with Google — there&rsquo;s no password to change.
          </p>
        )}
      </div>

      <ExportDataCard />
      <ImportDataCard />
      <DeleteAccountCard
        email={email}
        hasPassword={hasPassword}
        googleReauthenticatedAt={googleReauthenticatedAt}
      />
    </div>
  );
};
