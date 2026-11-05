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

Assumptions (all accepted by the owner):

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
  balances but stay hidden until upgrade. (Follow-up, not in this change: have the import
  summary say how many rows landed outside the visible window.)
- **Downgrade behaviour per gated feature** (follows "read-only over limit"):
  - Accounts: keep all existing, block creating a third and up.
  - Trends: page shows an upgrade prompt and `getSpendingTrends` refuses (there's no
    trends API route).
  - Reimbursable expenses: existing flags and links keep counting in Overview math so
    past numbers don't shift; marking new ones and creating or editing links is refused.
    Removing a flag or link is still allowed.
  - Statement cycles: `statementDay` stays stored but is ignored (calendar month view)
    and can't be set or changed.
  - Push reminders: the cron skips Free users; saved preferences and device
    subscriptions are kept so they resume on upgrade.

## Open questions

- [x] Does the settings data import respect the account limit? **Yes**, a restore whose file
      has more accounts than the plan allows is refused before anything is wiped.
- [x] Is "2 accounts" counted across all account types? **Yes**, every `Account` row counts,
      including off-budget and investment accounts.
- [x] Does "Visible history" clamp the Categorize queue? **Yes**, transactions before the
      floor are hidden from the queue.
- [x] Data export? **Always exports all transactions**, on every plan.
- [x] Where does "Upgrade to Plus" go? **To an in-app page where the user enters payment
      details and the subscription is created** (see Subscribe below).
- [x] Bootstrap admin override? **No**, it's a normal user.

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

## Implementation notes

Where the build differs from the first draft of this plan:

- **Free has no `Plan` row.** A user with no entitled subscription gets `FREE_ENTITLEMENTS`
  straight from code, so `Plan` only holds paid plans and `stripeProductId` is required.
  `isDefault` and `sortOrder` were dropped; plans sort by their cheapest price.
- **Only Stripe products with `plan=true` metadata are synced**, so other products on the
  same Stripe account are ignored.
- **One error class, `PlanRestrictionError`** (`kind: 'limit' | 'feature'`), instead of two.
  `planErrorResponse` in `lib/http/planError.ts` maps it to 402 with
  `code: 'plan_limit' | 'plan_feature'`.
- **`/upgrade` lives outside `(protected)`** (`app/upgrade/`), because the protected layout
  redirects to a bare `/login`. The page does its own session check and sends a signed-out
  visitor to `/login?next=/upgrade`. `next` is carried through sign-in, Google sign-in and
  sign-up, and only `/upgrade` paths are honoured (`lib/auth/return-to.ts`).
- **Stripe's embedded mode is `ui_mode: 'embedded_page'`** in the pinned SDK (23.x), and the
  billing period end is read from the subscription item (`items.data[0].current_period_end`).
- **Client components read the plan from `PlanProvider`** (protected layout), so the period
  picker, account form, transaction form and settings don't need new props.
- **No `/api/billing/plans` route**: the upgrade page reads `listPlans()` on the server.
- **History clamp runs inside the services** (`getTransactionsPage`, `listTransactions`,
  `getCategorizeQueue`, `getCategorizeQueueStats`, nav badge, `getOverviewData`) and in the
  budgets page and budget month routes via `clampMonthToHistory`.

## Schema changes (approved)

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
  stripeProductId String   @unique
  name            String
  description     String?
  isActive        Boolean  @default(true)  // archived in Stripe = false
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

Free limits live in code (`FREE_ENTITLEMENTS`), not in a row or in Stripe.

## Request flows

**Subscribe**

1. "Upgrade to Plus" (marketing pricing page, billing settings, any `UpgradePrompt`) links
   to `/upgrade` (optionally `?price=<stripePriceId>`) in the app. A signed-out visitor goes
   through login or sign-up and comes back to it.
2. The `/upgrade` page shows the plan summary (name, C$4/month, what's included) next to
   **Stripe Embedded Checkout** (`ui_mode: 'embedded_page'`, `@stripe/stripe-js` +
   `@stripe/react-stripe-js`). The user enters card details on our page; Stripe handles
   the card form, 3-D Secure, Apple/Google Pay and SCA, so no card data touches our server
   and PCI scope stays at SAQ A.
3. On load the page calls `POST /api/billing/checkout { priceId }` →
   `createCheckoutSession(userId, priceId)`: gets or creates the Stripe Customer (stored on
   `User.stripeCustomerId`, `metadata.userId` set), refuses if the user already has an
   active paid subscription (they get sent to the portal instead), and creates a
   `subscription` mode Checkout Session with `client_reference_id = userId`,
   `return_url = /upgrade/complete?session_id={CHECKOUT_SESSION_ID}`. Returns the
   `client_secret` for the embedded form.
4. Submitting the form creates the Stripe subscription. `/upgrade/complete` reads the
   session through `getCheckoutResult(userId, sessionId)` (checks it belongs to the user)
   and, if paid, upserts the `Subscription` row right away so the user sees Plus without
   waiting on the webhook. The webhook does the same upsert, so whichever lands first wins
   and the other is a no-op.
5. If the session is still open or failed, the page sends the user back to `/upgrade` with
   the error.

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
- `app/upgrade/page.tsx` + `components/billing/embedded-checkout-form.tsx`: plan
  summary and the embedded payment form, with loading, error and "already on Plus" states.
- `app/upgrade/complete/page.tsx`: success state ("You're on Plus") linking to
  the dashboard, or the retry path.
- `UpgradePrompt` shared component used wherever a 402 comes back (inline message with a
  link to billing), plus disabled states for gated nav items.
- Billing section and links are hidden entirely when billing is disabled.

## Env vars

Add to `.env.example`: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`,
`NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`. The return URL reuses `appBaseUrl()`.

New dependencies: `stripe` (server SDK, pin the API version in the client constructor),
`@stripe/stripe-js` and `@stripe/react-stripe-js` (embedded form on the client).

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
- `createCheckoutSession`: reuses an existing customer, refuses an unknown or inactive price,
  refuses when already subscribed. `getCheckoutResult`: rejects another user's session,
  upsert is idempotent with the webhook.

E2E (`tests/e2e/billing.spec.ts`). The suite's single dev server runs with billing off (the
other specs rely on every feature being on), so e2e covers that posture plus the sign-in
return path:

- A signed-out visitor sent to `/upgrade` signs up, signs in and lands back on it.
- A `next` outside the allowlist is ignored.
- With billing off there's no Plan card, Trends isn't locked and a third account is allowed.

The Free limits themselves are covered by unit tests (`plan-gates.test.ts`,
`entitlements.test.ts`). Follow-up: a second Playwright project with billing on and a seeded
`Subscription` row would let e2e cover the Free prompts too.

Manual: Stripe CLI `stripe listen --forward-to localhost:3000/api/stripe/webhook` with a test
card through the full subscribe, switch, cancel flow.

## Checklist

- [x] Get the restriction list from the owner's screenshots
- [x] Confirm assumptions and open questions above
- [x] Get schema change approval
- [x] Add `stripe` dependency, `lib/billing/stripe.ts` client singleton, env vars
- [x] Schema + migration (`Plan`, `PlanPrice`, `Subscription`, `StripeEvent`,
      `User.stripeCustomerId`)
- [x] `lib/billing/entitlements.ts` types, Zod metadata parser, unlimited constant
- [x] `lib/services/billing.ts`: `listPlans`, `getBillingSummary`, `createCheckoutSession`,
      `getCheckoutResult`, `createPortalSession`, `handleStripeEvent`, `cancelSubscriptionForDeletion`
- [x] `lib/services/entitlements.ts`: `getEntitlements`, `assertCanCreate`, `assertFeature`,
      `getHistoryFloor`
- [x] `PlanRestrictionError` in `lib/services/common.ts` and 402 mapping in `lib/http`
- [x] Routes: `/api/billing/checkout`, `/api/billing/portal`, `/api/stripe/webhook`
- [x] `stripe:sync-plans` script
- [x] Gate accounts (`createAccount`, data restore)
- [x] Gate trends, reimbursements, statement cycles, push reminders (incl. cron filter)
- [x] Apply history floor to transactions, overview, budgets, ZBB, categorize, period picker
- [x] Hook subscription cancel into `accountDeletion.ts`
- [x] `/upgrade` page with Embedded Checkout and `/upgrade/complete`
- [x] Plan card in Settings, `UpgradePrompt`, gated form fields and picker months
- [ ] Point the marketing site's "Upgrade to Plus" button at `/upgrade` (outside this repo)
- [x] Unit tests and e2e spec
- [x] README: Stripe setup steps (products, metadata keys, webhook endpoint, portal config)
- [x] `npm run format:fix && npm run lint`, `npm run test`, `npm run test:e2e`
