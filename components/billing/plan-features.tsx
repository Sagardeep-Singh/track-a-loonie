import { Check } from 'lucide-react';
import { FEATURE_KEYS, FEATURE_LABELS, type Entitlements } from '@/lib/billing/entitlements';

/** The checklist under a plan, written from its entitlements so it can't drift. */
export const planFeatureLines = (entitlements: Entitlements): string[] => [
  entitlements.limits.accounts === null
    ? 'Unlimited accounts'
    : `${entitlements.limits.accounts} accounts`,
  entitlements.historyMonths === null
    ? 'All of your history'
    : `Your last ${entitlements.historyMonths} months of history`,
  ...FEATURE_KEYS.filter((key) => entitlements.features[key]).map((key) => FEATURE_LABELS[key]),
];

export const PlanFeatures = ({
  entitlements,
}: {
  entitlements: Entitlements;
}): React.ReactElement => (
  <ul className="flex flex-col gap-2.5">
    {planFeatureLines(entitlements).map((line) => (
      <li key={line} className="text-ink flex items-start gap-2.5 text-sm">
        <Check size={16} className="text-iris mt-0.5 shrink-0" aria-hidden />
        {line}
      </li>
    ))}
  </ul>
);
