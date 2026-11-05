import { z } from 'zod';

/**
 * What a plan allows. Free is defined here, in code; paid plans come from
 * their Stripe Product's metadata (see `parseEntitlementsMetadata`) and are
 * stored on `Plan.entitlements`.
 */

export const LIMIT_KEYS = ['accounts'] as const;
export type LimitKey = (typeof LIMIT_KEYS)[number];

export const FEATURE_KEYS = [
  'trends',
  'reimbursements',
  'statementCycles',
  'pushReminders',
] as const;
export type FeatureKey = (typeof FEATURE_KEYS)[number];

export type Entitlements = {
  /** null = unlimited */
  limits: Record<LimitKey, number | null>;
  /** months the user can browse, counting the current one; null = all */
  historyMonths: number | null;
  features: Record<FeatureKey, boolean>;
};

export const FREE_ENTITLEMENTS: Entitlements = {
  limits: { accounts: 2 },
  historyMonths: 12,
  features: {
    trends: false,
    reimbursements: false,
    statementCycles: false,
    pushReminders: false,
  },
};

/** Billing turned off (no Stripe key): self-hosted installs get everything. */
export const UNLIMITED_ENTITLEMENTS: Entitlements = {
  limits: { accounts: null },
  historyMonths: null,
  features: {
    trends: true,
    reimbursements: true,
    statementCycles: true,
    pushReminders: true,
  },
};

export const FEATURE_LABELS: Record<FeatureKey, string> = {
  trends: 'Spending trends',
  reimbursements: 'Reimbursable expenses',
  statementCycles: 'Credit card statement cycles',
  pushReminders: 'Push reminders',
};

/** Stripe metadata key for each limit and feature. */
const LIMIT_METADATA: Record<LimitKey, string> = { accounts: 'limit_accounts' };
const FEATURE_METADATA: Record<FeatureKey, string> = {
  trends: 'feature_trends',
  reimbursements: 'feature_reimbursements',
  statementCycles: 'feature_statement_cycles',
  pushReminders: 'feature_push_reminders',
};
const HISTORY_METADATA = 'history_months';

const countValue = z.union([
  z.literal('unlimited').transform(() => null),
  z.literal('all').transform(() => null),
  z.coerce.number().int().positive(),
]);
const flagValue = z.enum(['true', 'false']).transform((v) => v === 'true');

/**
 * Stripe Product metadata → Entitlements. Metadata values are strings:
 * `limit_accounts=unlimited`, `history_months=all`, `feature_trends=true`.
 * A key that is missing or malformed keeps the Free value, so a typo in the
 * dashboard never grants more than Free.
 */
export const parseEntitlementsMetadata = (metadata: Record<string, string>): Entitlements => {
  const read = <T>(key: string, schema: z.ZodType<T>, fallback: T): T => {
    const raw = metadata[key];
    if (raw === undefined) return fallback;
    const parsed = schema.safeParse(raw.trim().toLowerCase());
    return parsed.success ? parsed.data : fallback;
  };
  const limits = Object.fromEntries(
    LIMIT_KEYS.map((k) => [k, read(LIMIT_METADATA[k], countValue, FREE_ENTITLEMENTS.limits[k])]),
  ) as Entitlements['limits'];
  const features = Object.fromEntries(
    FEATURE_KEYS.map((k) => [
      k,
      read(FEATURE_METADATA[k], flagValue, FREE_ENTITLEMENTS.features[k]),
    ]),
  ) as Entitlements['features'];
  return {
    limits,
    historyMonths: read(HISTORY_METADATA, countValue, FREE_ENTITLEMENTS.historyMonths),
    features,
  };
};

const entitlementsSchema = z.object({
  limits: z.object({ accounts: z.number().int().positive().nullable() }),
  historyMonths: z.number().int().positive().nullable(),
  features: z.object({
    trends: z.boolean(),
    reimbursements: z.boolean(),
    statementCycles: z.boolean(),
    pushReminders: z.boolean(),
  }),
});

/** `Plan.entitlements` JSON → Entitlements; anything unreadable falls back to Free. */
export const readStoredEntitlements = (value: unknown): Entitlements => {
  const parsed = entitlementsSchema.safeParse(value);
  return parsed.success ? parsed.data : FREE_ENTITLEMENTS;
};

/** `YYYYMM` of the oldest visible month, or null when history is unlimited. */
export const historyFloorMonth = (entitlements: Entitlements, now: Date): number | null => {
  if (entitlements.historyMonths === null) return null;
  const floor = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (entitlements.historyMonths - 1), 1),
  );
  return floor.getUTCFullYear() * 100 + (floor.getUTCMonth() + 1);
};

/** First instant of a `YYYYMM` month, UTC (matches the app's month helpers). */
export const monthStartDate = (month: number): Date =>
  new Date(Date.UTC(Math.floor(month / 100), (month % 100) - 1, 1));
