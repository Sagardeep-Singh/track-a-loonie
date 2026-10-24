# Stripe subscriptions and plan restrictions

## Problem

The app is free and unlimited for everyone. We want paid plans: a Free tier with limits and
one or more paid tiers that lift them, billed through Stripe. Plans need to be defined
somewhere users can pick from, and the app has to enforce each plan's limits on the server.

## Plans

From the owner's pricing page (trackaloonie.ca/pricing, not in this repo):

| Feature                                      | Free           | Plus (C$4/month) |
| -------------------------------------------- | -------------- | ---------------- |
| Accounts                                     | 2              | Unlimited        |
| Visible history                              | Last 12 months | All              |
| Manual transactions, CSV import, import undo | Included       | Included         |
| Bank CSV presets (coming soon)               | Included       | Included         |
| Categories, rules, Categorize queue          | Included       | Included         |
| Monthly budgets, Overview, drilldowns        | Included       | Included         |
| Transfer matching                            | Included       | Included         |
| AI suggestions (your own key)                | Included       | Included         |
| Data export, account deletion                | Always         | Always           |
| Spending trends                              | Not included   | Included         |
| Reimbursable expenses                        | Not included   | Included         |
| Credit card statement cycles                 | Not included   | Included         |
| Push reminders                               | Not included   | Included         |

So the restrictions are one count limit (accounts), one history window, and four feature
flags. Everything else stays ungated. Monthly price only for now; the model supports a yearly
Price later with no code change.

## Scope

- Users see the available plans, subscribe through Stripe Checkout, and manage or cancel
  through the Stripe Customer Portal.
- Plans and their limits are defined in Stripe. The app mirrors them into a local `Plan`
  table through webhooks so limit checks never call Stripe at request time.
- Every user without an active paid subscription is on the Free plan.
- Services enforce the user's entitlements before creating gated records or running gated
  features.

Non-goals for v1:

- An in-app admin screen for plans (Stripe dashboard is the admin UI).
- Coupons, promo codes and trials (Stripe Checkout can turn these on later with no app change).
- Taxes beyond what Stripe Tax does by flag, invoices UI, team or family plans.
- Usage-based (metered) billing.

## Decisions

Locked with the owner:

- **Stripe is the source of truth for plans.** Each plan is a Stripe Product with one or more
  Prices (monthly, yearly). Limits live in Product metadata (see Entitlements). A webhook
  upserts them into a local `Plan` row. No roles or admin flag are added.
- **Free plan + paid upgrades.** Free is a local `Plan` row with `stripeProductId = null` and
  `isDefault = true`. Existing users fall onto Free with no migration of their data.
- **Read-only over limit.** When a user downgrades or a subscription lapses, nothing is
  deleted or hidden. Existing records stay visible and editable, but creating new ones past a
  limit is refused and gated features turn off.

Assumptions (confirm before implementation):

- **Billing is optional for self-hosters.** When `STRIPE_SECRET_KEY` is unset, billing UI is
  hidden and every user gets unlimited entitlements. Same pattern as Google sign-in being
  shown only when its env vars exist. This keeps the AGPL self-host story intact.
- **Grace on `past_due`.** Stripe's own retry window applies. The user keeps the paid plan
  while the subscription is `active`, `trialing` or `past_due`, and drops to Free on
  `unpaid`, `canceled` or `incomplete_expired`.
- **Cancel at period end.** Cancelling in the portal keeps the plan until
  `current_period_end`.
- **Account deletion cancels the subscription** immediately in Stripe before the user row is
  deleted.
- **Currency CAD.** Prices are whatever is set in Stripe; the app only displays them.
- **History window is a view limit, not a data limit.** Older transactions are kept and
  still count in running math (account balances, zero-based carryover, savings goal
  progress, transfer and reimbursement links). Free users just can't browse, filter or
  report on months before the window. Upgrading reveals them instantly.
- **Window = current month plus the 11 before it**, computed in the user's month terms
  (same month helpers as the period picker). Future-dated transactions stay visible.
- **Data export is never limited.** It includes all history on every plan.
- **CSV import of rows older than the window is allowed.** The rows save and count toward
  balances but stay hidden until upgrade. The import summary says how many rows landed
  outside the visible window.
- **Downgrade behaviour per gated feature** (follows "read-only over limit"):
  - Accounts: keep all existing, block creating a third and up.
  - Trends: page shows an upgrade prompt, API returns 402.
  - Reimbursable expenses: existing flags and links keep counting in Overview math so
    past numbers don't shift; marking new ones and creating or editing links is refused.
    Removing a flag or link is still allowed.
  - Statement cycles: `statementDay` stays stored but is ignored (calendar month view)
    and can't be set or changed.
  - Push reminders: the cron skips Free users; saved preferences and device
    subscriptions are kept so they resume on upgrade.

## Open questions

- [ ] Does the settings data import (`/api/settings/import`) respect the account limit, or
      is a restore always allowed? Suggest: refuse with a clear message when the file has
      more accounts than the plan allows, so a restore can't be used to skip the limit.
- [ ] Is "2 accounts" counted across all account types, including off-budget and
      investment accounts? Suggest: yes, every `Account` row counts.
- [ ] Should "Visible history" also clamp the Categorize queue, or can Free users still
      categorize old uncategorized imports? Suggest: clamp it, consistent with the rule.
- [ ] Does the pricing page in the marketing site need a link-up (Upgrade button pointing
      to `/settings/billing` or straight into Checkout)?
- [ ] Should the bootstrap admin user get a permanent unlimited override? Suggest: no, keep
      it a normal user.

## Entitlements model

One typed shape for every plan, with a parser that validates Stripe metadata through Zod.

```ts
// lib/billing/entitlements.ts
export type LimitKey = 'accounts';
export type FeatureKey = 'trends' | 'reimbursements' | 'statementCycles' | 'pushReminders';

export type Entitlements = {
  limits: Record<LimitKey, number | null>; // null = unlimited
  historyMonths: number | null; // null = all history
  features: Record<FeatureKey, boolean>;
};

export const FREE_ENTITLEMENTS: Entitlements = {
  limits: { accounts: 2 },
  historyMonths: 12,
  features: { trends: false, reimbursements: false, statementCycles: false, pushReminders: false },
};
```

Stripe Product metadata uses flat keys: `limit_accounts=unlimited`, `history_months=all`,
`feature_trends=true`, and so on. Any key missing from metadata falls back to the Free value,
so a typo never grants more than Free. `UNLIMITED_ENTITLEMENTS` is used when billing is
disabled. New keys later only need a union member, a Free default and a metadata entry.

## Schema changes (needs approval)

```prisma
enum SubscriptionStatus {
  ACTIVE
  TRIALING
  PAST_DUE
  UNPAID
  CANCELED
  INCOMPLETE
  INCOMPLETE_EXPIRED
  PAUSED
}

model Plan {
  id              String   @id @default(cuid())
  stripeProductId String?  @unique   // null for the Free plan
  name            String
  description     String?
  isDefault       Boolean  @default(false) // exactly one: Free
  isActive        Boolean  @default(true)  // archived in Stripe = false
  sortOrder       Int      @default(0)
  entitlements    Json                      // parsed Entitlements
  prices          PlanPrice[]
  subscriptions   Subscription[]
  updatedAt       DateTime @updatedAt
}

model PlanPrice {
  id            String  @id @default(cuid())
  planId        String
  stripePriceId String  @unique
  unitAmount    Int                  // cents
  currency      String
  interval      String               // month | year
  isActive      Boolean @default(true)
  plan          Plan    @relation(fields: [planId], references: [id], onDelete: Cascade)
}

model Subscription {
  id                   String             @id @default(cuid())
  userId               String             @unique
  planId               String
  stripeSubscriptionId String             @unique
  stripePriceId        String
  status               SubscriptionStatus
  currentPeriodEnd     DateTime
  cancelAtPeriodEnd    Boolean            @default(false)
  updatedAt            DateTime           @updatedAt
  user                 User               @relation(fields: [userId], references: [id], onDelete: Cascade)
  plan                 Plan               @relation(fields: [planId], references: [id])
}

model StripeEvent {        // webhook idempotency
  id         String   @id // Stripe event id
  type       String
  receivedAt DateTime @default(now())
}
```

`User` gets `stripeCustomerId String? @unique` and `subscription Subscription?`.

The Free plan row is created by the migration (or an idempotent `ensureFreePlan` on boot) with
its entitlements, so Free limits live in code and Git, not in Stripe.

## Request flows

**Subscribe**

1. Pricing page lists active plans and prices from `listPlans()`.
2. `POST /api/billing/checkout { priceId }` → `createCheckoutSession(userId, priceId)`: gets
   or creates the Stripe Customer (stored on `User.stripeCustomerId`, `metadata.userId`
   set), creates a `subscription` mode Checkout Session with `client_reference_id = userId`,
   returns its URL.
3. Stripe redirects back to `/settings/billing?checkout=success`. The page does not trust the
   redirect; it shows "Processing" until the webhook has written the subscription.

**Manage**

- `POST /api/billing/portal` → `createPortalSession(userId)` returns the Customer Portal URL.
  Plan switches, cancel and card updates all happen there.

**Webhook** `POST /api/stripe/webhook`

- Reads the raw body, verifies with `STRIPE_WEBHOOK_SECRET`, then calls
  `handleStripeEvent(event)`. No session required. Not covered by any auth middleware.
- Inserts `StripeEvent.id` first inside a transaction; a unique-violation means already
  processed and returns 200.
- Handled events:
  - `product.created|updated|deleted`, `price.created|updated|deleted` → sync `Plan` /
    `PlanPrice`.
  - `checkout.session.completed`, `customer.subscription.created|updated|deleted` →
    re-fetch the subscription from Stripe and upsert `Subscription` (fetching avoids
    out-of-order event bugs).
  - `invoice.payment_failed` → no state change beyond what the subscription event carries;
    optional email later.
- A manual `npm run stripe:sync-plans` script pulls all products and prices once, for
  bootstrapping and for recovering from missed webhooks.

## Enforcement

`lib/services/entitlements.ts`:

```ts
export const getEntitlements = async (userId: string): Promise<Entitlements>;
export const assertCanCreate = async (userId: string, key: LimitKey): Promise<void>;
export const assertFeature = async (userId: string, key: FeatureKey): Promise<void>;
```

- `getEntitlements` returns the active subscription's plan entitlements, else Free, else
  unlimited when billing is disabled.
- `assertCanCreate` counts the user's current rows for that key and throws
  `PlanLimitError` when `count >= limit`.
- `assertFeature` throws `PlanFeatureError` when the flag is off.
- Both new errors extend `ServiceValidationError` (same pattern as
  `ReimbursementConflictError`) so existing handlers keep working; routes that want a
  dedicated status map them to **402** with `{ error, code: 'plan_limit' | 'plan_feature',
key }` so the client can show an upgrade prompt.
- `getHistoryFloor(userId): Promise<Date | null>` returns the first day of the oldest
  visible month, or null when unlimited.
- Checks live in services only, never in route handlers:

| Restriction      | Enforcement points                                                                                                                                                                  |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Accounts         | `createAccount`; `importUserData` (per open question)                                                                                                                               |
| History          | Clamp the date range in `transactionsPage`, `transactions` list/search, `overview`, `budgets`, `zeroBased` month views, `categorize` queue; reject months before the floor with 402 |
| Trends           | `getSpendingTrends`; trends page and nav item                                                                                                                                       |
| Reimbursements   | Setting `isReimbursable` in `transactions` create/update, `createReimbursementLink`, `updateReimbursementLink`, `listReimbursementCandidates`                                       |
| Statement cycles | Setting `statementDay` in `createAccount`/`updateAccount`; `overview` and period picker ignore it on Free                                                                           |
| Push reminders   | `updateReminderPreference` (enable), `savePushSubscription`; `sendDueReminders` filters to entitled users                                                                           |

- History clamping only narrows what's returned or navigable. Running totals that depend on
  older rows (balances, ZBB carryover, goals) keep reading the full table.
- The count and the insert are not atomic. Accepting the rare race (two parallel creates
  landing one over the limit) is fine for v1; note it rather than adding locking.
- Server-rendered pages read `getEntitlements` to hide or disable gated UI. This is for UX
  only; the service check is the real guard.

## UI

- `app/(protected)/settings/billing/page.tsx`: current plan, status, renewal or end date,
  "Manage billing" button (portal), and the Free/Plus cards for Free users, matching the
  marketing pricing page copy.
- Plan cards component (`components/settings/billing/`): name, description, price, key
  limits, current-plan badge.
- Period picker and month selectors disable months before the history floor with a
  "Plus shows all your history" hint.
- Account form hides or locks the statement day field on Free.
- "Add account" shows the upgrade prompt once the user has 2.
- `UpgradePrompt` shared component used wherever a 402 comes back (inline message with a
  link to billing), plus disabled states for gated nav items.
- Billing section and links are hidden entirely when billing is disabled.

## Env vars

Add to `.env.example`: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`,
`NEXT_PUBLIC_APP_URL` (if not already derivable) for success and cancel URLs.

New dependency: `stripe` (server SDK only, pin the API version in the client constructor).

## Testing

Unit (`tests/unit/services/...`, Stripe client mocked):

- Entitlements parser: valid metadata, missing keys fall back to Free, bad values rejected.
- `getEntitlements`: no subscription → Free; each status maps to paid or Free; billing
  disabled → unlimited.
- `assertCanCreate` / `assertFeature`: under, at, and over the limit; null limit.
- Webhook handler: signature failure, duplicate event id is a no-op, product/price sync,
  subscription upsert, delete drops to Free.
- Each gated service method refuses at the limit and still allows update/delete over the
  limit.
- History floor: month boundary math, a Free user can't read a month before the floor,
  balances and ZBB carryover still include older rows, export includes everything.
- `sendDueReminders` skips Free users and resumes after upgrade.
- Account deletion cancels the Stripe subscription.

E2E (`tests/e2e/billing.spec.ts`), billing env set to Stripe test mode with Checkout stubbed
or a seeded subscription row:

- Free user with 2 accounts sees the upgrade prompt on "Add account".
- Free user sees Trends locked and can't pick a month older than 12 months.
- Seeded paid user can create past the Free limit.
- Billing page shows plan and status; hidden when billing is disabled.

Manual: Stripe CLI `stripe listen --forward-to localhost:3000/api/stripe/webhook` with a test
card through the full subscribe, switch, cancel flow.

## Checklist

- [x] Get the restriction list from the owner's screenshots
- [ ] Confirm assumptions and open questions above
- [ ] Get schema change approval
- [ ] Add `stripe` dependency, `lib/billing/stripe.ts` client singleton, env vars
- [ ] Schema + migration (`Plan`, `PlanPrice`, `Subscription`, `StripeEvent`,
      `User.stripeCustomerId`), seed the Free plan
- [ ] `lib/billing/entitlements.ts` types, Zod metadata parser, unlimited constant
- [ ] `lib/services/billing.ts`: `listPlans`, `getBillingSummary`, `createCheckoutSession`,
      `createPortalSession`, `handleStripeEvent`, `cancelSubscriptionForDeletion`
- [ ] `lib/services/entitlements.ts`: `getEntitlements`, `assertCanCreate`, `assertFeature`,
      `getHistoryFloor`
- [ ] `PlanLimitError` / `PlanFeatureError` in `lib/services/common.ts` and 402 mapping in
      `lib/http`
- [ ] Routes: `/api/billing/checkout`, `/api/billing/portal`, `/api/billing/plans`,
      `/api/stripe/webhook`
- [ ] `stripe:sync-plans` script
- [ ] Gate accounts (`createAccount`, data import)
- [ ] Gate trends, reimbursements, statement cycles, push reminders (incl. cron filter)
- [ ] Apply history floor to transactions, overview, budgets, ZBB, categorize, period picker
- [ ] Hook subscription cancel into `accountDeletion.ts`
- [ ] Billing settings page, plan cards, `UpgradePrompt`, gated nav states
- [ ] Unit tests and e2e spec
- [ ] README: Stripe setup steps (products, metadata keys, webhook endpoint, portal config)
- [ ] `npm run format:fix && npm run lint`, `npm run test`, `npm run test:e2e`
