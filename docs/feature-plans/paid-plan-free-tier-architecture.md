# Paid plan with a free tier: architecture

Companion to `paid-plan-free-tier.md` (product scope and decisions). This is
the software-architect design, grounded in the current code. File:line
references were refreshed against `main` at `f3e77bb` (after #86 rename, #88
zero-based budgeting and #92 password reset) and may drift.

## Corrections to the product plan

The scope doc made a few assumptions that don't match the code:

1. **No auth proxy.** `proxy.ts` only handles the `/transactions` period
   redirect. Auth is per route (`requireUserId`) plus the protected layout. The
   webhook route needs no exclusion; it must not call `requireUserId` and must
   not live under `app/(protected)/`.
2. **Trends has no API route.** `app/(protected)/trends/page.tsx:56` calls the
   service directly and there is no `error.tsx` in `app/`. The page must
   pre-check and clamp to 3 months; the service gate is only a backstop.
3. **Marking an expense reimbursable** happens in `transactions.ts`
   (`createTransaction` and `updateTransaction`), not `reimbursements.ts`. Both
   are gated.
4. **Statement day on edit.** `components/accounts/account-form.tsx:40` sends
   `statementDay` on every save. Only a change to a new non-null value is
   gated, so trial-era cards stay editable.
5. **Routes would mis-map the plan error.** The PATCH routes map
   `ServiceValidationError` to 404, and `push/subscribe` and
   `settings/reminders` have no catch at all. Each needs a `PlanRequiredError`
   branch first.
6. **Webhook is the only source of truth.** The `?billing=success` redirect
   can arrive before the webhook. Settings shows "Payment processing, refresh
   in a moment"; it never syncs from the redirect.
7. **Card backstop needs `charge.succeeded`,** which wasn't in the doc's event
   list.
8. **Google account id.** `findOrCreateGoogleUser` only receives the email
   today. The Google `sub` is `account.providerAccountId` in the `jwt` callback
   (`lib/auth/config.ts:86`) and has to be passed through.
9. **`stripe` is not installed.**
10. **Password reset also verifies the email.** `resetPassword`
    (`lib/services/passwordReset.ts:203`, added in #92) sets `emailVerified`
    when it was null, since a valid reset link proves the mailbox. It is a
    third trial start path alongside verification and Google signup.
11. **Google emails are normalized now.** `findOrCreateGoogleUser` runs
    `normalizeEmail` before the lookup (#92), so a mixed-case Google email
    can't create a duplicate user.
12. **Account deletion was reworked** for Google re-auth. The `$transaction`
    is at `lib/services/accountDeletion.ts:48`, after the password and
    `reauthenticatedAt` checks.
13. **No account archive flag.** `Account` has no archived or soft-delete
    column, so the free account limit counts every row for the user.

## 1. Schema

All approved by the product owner.

```prisma
enum SubscriptionStatus {
  INCOMPLETE
  INCOMPLETE_EXPIRED
  TRIALING
  ACTIVE
  PAST_DUE
  CANCELED
  UNPAID
  PAUSED
}

enum BillingInterval {
  MONTH
  YEAR
}

model User {
  // existing fields...
  /// set when the app trial starts (email verified, or Google signup). Null =
  /// no trial: unverified, or this identity already claimed one.
  trialStartedAt      DateTime?
  /// set when the daily cron claims the one trial-ending email
  trialReminderSentAt DateTime?
  subscription        Subscription?
}

/// One row per user, created when the user first opens Checkout (holds the
/// Stripe customer). Subscription fields stay null until a webhook syncs.
model Subscription {
  id                   String              @id @default(cuid())
  userId               String              @unique
  stripeCustomerId     String              @unique
  stripeSubscriptionId String?             @unique
  status               SubscriptionStatus?
  interval             BillingInterval?
  currentPeriodEnd     DateTime?
  cancelAtPeriodEnd    Boolean             @default(false)
  createdAt            DateTime            @default(now())
  updatedAt            DateTime            @updatedAt

  user User @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([status])
}

/// Webhook idempotency ledger. No relation to User.
model StripeEvent {
  id          String   @id // Stripe event id (evt_...)
  type        String
  processedAt DateTime @default(now())
}

/// One trial per person. No relation to User, so it survives account
/// deletion. Holds only HMAC-SHA256 hashes, never a plain email or Google id.
model TrialClaim {
  emailHash     String   @id
  googleSubHash String?  @unique
  claimedAt     DateTime @default(now())

  @@index([claimedAt])
}

/// Outbox for Stripe customers whose app account was deleted. No relation to
/// User. Written in the deletion transaction, removed once Stripe confirms.
model StripeCustomerCleanup {
  stripeCustomerId String    @id
  createdAt        DateTime  @default(now())
  attempts         Int       @default(0)
  lastAttemptAt    DateTime?
  lastError        String?
}
```

- `stripeSubscriptionId` and `status` are nullable so the row can be created
  before Checkout and the Stripe customer is reused, never duplicated.
- `onDelete: Cascade` removes the Subscription row with the user. It does not
  stop billing in Stripe; account deletion handles that (below).
- `wipeUserData` (`userData.ts:220`) must not touch `Subscription`,
  `TrialClaim`, `StripeCustomerCleanup` or the trial fields, so a data import
  never resets billing or the trial. Export includes none of them.
- `StripeCustomerCleanup` was added on 2026-10-05 to support the "never block
  deletion" decision (section 9). It stores only the Stripe customer id.

### Account deletion

Deletion is never blocked by Stripe. It uses an outbox so a Stripe outage
can't strand a live subscription:

1. In `lib/services/accountDeletion.ts`, inside the existing
   `prisma.$transaction` (:48) and before `tx.user.delete`, read the user's
   `Subscription.stripeCustomerId`. When there is one, insert a
   `StripeCustomerCleanup` row with it (`createMany` + `skipDuplicates`).
2. After the transaction commits, call
   `await cancelBillingForDeletion(stripeCustomerId)` best effort:
   `stripe.customers.del` cancels every subscription at once and removes
   stored cards. On success, or on `resource_missing`, delete the outbox row.
   On any other error, log it, bump `attempts`, set `lastError`, and still
   return `{ ok: true }` to the user.
3. The daily cron retries outbox rows (section 7). After 10 failed attempts
   it logs at error level each run so the failure is visible.

Outcomes:

- No 503 path. `app/api/settings/account/route.ts` is unchanged.
- If the DB transaction fails, Stripe was never touched, so the user keeps a
  working account and a working customer (fixes the old ordering risk).
- With billing off, step 1 still writes nothing (no Subscription row) and
  step 2 is skipped.
- Later `customer.subscription.deleted` webhooks find no row and are
  ignored. `customer.deleted` isn't subscribed (section 4).
- `TrialClaim` is never deleted here.
- No refund on deletion (decision 1). The refund policy says so.

## 2. Files

### New

**`lib/billing/stripe.ts`** (transport seam, like `lib/push/webPush.ts`)

```ts
export const isBillingEnabled = (): boolean; // Boolean(process.env.STRIPE_SECRET_KEY)
export const getStripe = (): Stripe; // globalThis singleton, apiVersion pinned
export const priceIdFor = (interval: 'month' | 'year'): string; // BillingDisabledError if unset
export const constructStripeEvent = (rawBody: string, signature: string | null): Stripe.Event; // WebhookSignatureError
export const billingConfigProblems = (env?: NodeJS.ProcessEnv): string[]; // names of missing required vars, [] when billing is off
```

**`instrumentation.ts`** (new, repo root): `register()` calls
`billingConfigProblems()`. When `STRIPE_SECRET_KEY` is set and anything is
missing, it throws in production (`NODE_ENV === 'production'`) so the deploy
fails to boot, and logs a warning in dev. Required with billing on:
`STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_MONTHLY`, `STRIPE_PRICE_YEARLY`,
`TRIAL_HASH_KEY` (decision 7) and the Brevo vars `isEmailConfigured()` checks
(decision 6). Read `node_modules/next/dist/docs/` for the Next 16
instrumentation API before writing it.

**`lib/services/entitlements.ts`**

```ts
export type Plan = 'free' | 'trial' | 'paid';
export const TRIAL_DAYS = 30;
export const FREE_ACCOUNT_LIMIT = 2;
export const FREE_TRENDS_RANGES: readonly TrendsRange[] = [3];
export const PAID_STATUSES: SubscriptionStatus[] = ['ACTIVE', 'TRIALING', 'PAST_DUE'];
export const trialEndsAt = (trialStartedAt: Date): Date;
export const resolvePlan = (input: {
  billingEnabled: boolean;
  trialStartedAt: Date | null;
  status: SubscriptionStatus | null;
  now: Date;
}): Plan; // pure, truth table in section 5
export const getPlan = (userId: string, now?: Date): Promise<Plan>; // no query when billing is off
export const hasFeature = (userId: string, feature: PlanFeature, now?: Date): Promise<boolean>;
export const assertFeature = (userId: string, feature: PlanFeature, now?: Date): Promise<void>;
export const assertAccountLimit = (userId: string, now?: Date): Promise<void>;
export const listUserIdsWithFeature = (userIds: string[], feature: PlanFeature, now: Date): Promise<Set<string>>;
export type PlanSummary = {
  billingEnabled: boolean;
  plan: Plan;
  trialEndsAt: string | null;
  trialDaysLeft: number | null;
  trialStatus: 'not_started' | 'active' | 'ended' | 'used' | null; // null when billing is off
  subscription: {
    status: Lowercase<SubscriptionStatus>;
    interval: 'month' | 'year' | null;
    currentPeriodEnd: string | null;
    cancelAtPeriodEnd: boolean;
  } | null;
  paymentFailed: boolean; // status === PAST_DUE
  features: Record<PlanFeature, boolean>;
  accountLimit: number | null; // 2 on free, otherwise null
};
export const getPlanSummary = (userId: string, now?: Date): Promise<PlanSummary>;
```

Free users get none of the five features; trial and paid users get all of
them. User-facing messages come from a `PLAN_FEATURE_MESSAGES` map.

**`lib/trial/normalizeEmail.ts`** (pure, no I/O)

```ts
export const normalizeEmailForTrial = (email: string): string;
```

- Trim, lowercase, split on the last `@`.
- Drop everything from the first `+` in the local part. If that leaves the
  local part empty, keep the original (so `+x@gmail.com` stays distinct).
- For `gmail.com` and `googlemail.com`: remove dots from the local part and
  map the domain to `gmail.com`.
- If any step leaves the local part empty (`.+x@gmail.com`), return the
  trimmed, lowercased original instead.
- No `@`, or an empty domain: return the trimmed, lowercased input. Never
  throws. Always idempotent (`f(f(x)) === f(x)`).

**`lib/services/trialClaims.ts`**

```ts
export const isTrialAbuseCheckEnabled = (): boolean; // Boolean(process.env.TRIAL_HASH_KEY)
export const hashTrialIdentity = (value: string): string; // HMAC-SHA256 hex
export type StartTrialResult = 'started' | 'already_started' | 'ineligible';
export const startTrialInTx = (
  tx: Prisma.TransactionClient,
  user: { id: string; email: string; trialStartedAt: Date | null },
  options: { googleSub?: string | null; now: Date },
): Promise<StartTrialResult>;
export const pruneTrialClaims = (now: Date): Promise<number>; // claimedAt older than 730 days
```

`startTrialInTx`:

1. `trialStartedAt` already set: return `already_started`.
2. `TRIAL_HASH_KEY` unset: set `trialStartedAt = now`, return `started`. No
   hashing or claim check. Only reachable with billing off, since the boot
   check requires the key when billing is on (decision 7).
3. Otherwise compute
   `emailHash = hash('email:' + normalizeEmailForTrial(email))` and
   `googleSubHash = googleSub ? hash('google:' + googleSub) : null`. Both
   values carry a prefix so the two namespaces can never collide. An empty
   `googleSub` counts as none.
4. `tx.trialClaim.createMany({ data: [{ emailHash, googleSubHash, claimedAt: now }], skipDuplicates: true })`.
   A count of 0 means that email or Google account already has a claim:
   return `ineligible` and leave `trialStartedAt` null.
5. Set `trialStartedAt = now`, return `started`.

`skipDuplicates` is Postgres `ON CONFLICT DO NOTHING`, so it covers both the
primary key and the unique Google column in one atomic statement, never
aborts the surrounding transaction (a P2002 would), and settles races such as
`a+1@gmail.com` and `a+2@gmail.com` verifying at the same moment. A refused
trial never blocks signup or verification; the user just starts on free.

Disposable-email blocklist: **not in v1.** The lists go stale and often flag
privacy relays (SimpleLogin, Firefox Relay, iCloud Hide My Email). If added
later, it plugs in before step 4 as another `ineligible` reason, server-only,
with its licence checked against AGPLv3.

**`lib/services/billing.ts`**

```ts
export const createCheckoutSession = (userId: string, interval: 'month' | 'year', now?: Date): Promise<{ url: string }>;
export const createPortalSession = (userId: string): Promise<{ url: string }>;
export const handleStripeEvent = (event: Stripe.Event): Promise<'processed' | 'duplicate' | 'ignored'>;
export const cancelBillingForDeletion = (stripeCustomerId: string): Promise<void>; // best effort, never throws to the caller
export const retryStripeCustomerCleanups = (now: Date): Promise<{ attempted: number; cleaned: number; failed: number }>;
```

**`lib/services/trialEmails.ts`**:
`sendTrialEndingEmails(now: Date): Promise<{ candidates: number; sent: number; failed: number }>`

**`lib/email/trial-ending-email.ts`**:
`buildTrialEndingEmail({ appUrl, settingsUrl, trialEndsAt }): TransactionalEmail`,
using `renderEmailHtml` like `account-exists-email.ts`.

**`lib/email/subscription-cancelled-country-email.ts`** (decision 5):
`buildCountryCancellationEmail({ appUrl, refunded }): TransactionalEmail`.
Says the subscription was cancelled because the card isn't Canadian, whether
a refund was issued, and that the free tier still works. Sent from the
webhook handler after the cancel. A send failure is logged and never fails
the webhook.

**`lib/http/clientCountry.ts`**

```ts
export const COUNTRY_HEADER = 'x-vercel-ip-country';
export const clientCountryFromHeaders = (headers: Headers): string | null; // trimmed, uppercased, /^[A-Z]{2}$/ or null
export const allowedSignupCountries = (env?: NodeJS.ProcessEnv): string[] | null; // null when unset/empty; [] (refuse all) plus an error log when set but no entry is a valid code
export const isSignupCountryAllowed = (country: string | null, env?: NodeJS.ProcessEnv): boolean;
```

**`lib/http/planRequired.ts`**: `planRequiredResponse(error)` returns 402
`{ error, code: 'plan_required', feature }`.

**`lib/validators/billing.ts`**:
`checkoutSchema = z.object({ interval: z.enum(['month', 'year']) })`.

**Routes:** `app/api/billing/checkout/route.ts`,
`app/api/billing/portal/route.ts`, `app/api/billing/webhook/route.ts` (all
POST).

**UI:** `app/pricing/page.tsx` (public, `notFound()` when billing is off) and
`components/billing/` (upgrade prompt, Plan section). Specced by ui-designer.

### Modified, with gate placement

| File:line                                                                                 | Change                                                                                                                                                                                                                                                 |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `lib/services/common.ts`                                                                  | `PlanFeature`, `PlanRequiredError`, `BillingDisabledError`, `BillingConflictError`, `BillingProviderError`                                                                                                                                             |
| `lib/services/accounts.ts:68` (`createAccount`)                                           | `assertAccountLimit(userId)`; if `CREDIT_CARD` with non-null `statementDay`, `assertFeature(userId, 'statementCycles')`. `onBudget` (#88) is never gated                                                                                               |
| `lib/services/accounts.ts:90` (`updateAccount`)                                           | Gate `statementCycles` only when `statementDay` changes to a new non-null value (compare with the stored value; `undefined` means no change). Clearing it stays allowed                                                                                |
| `lib/services/transactions.ts:153` (`createTransaction`)                                  | `if (input.isReimbursable) assertFeature(userId, 'reimbursements')`                                                                                                                                                                                    |
| `lib/services/transactions.ts:179` (`updateTransaction`)                                  | Gate only the false to true change of `isReimbursable`. Un-marking and editing an existing reimbursable stay allowed                                                                                                                                   |
| `lib/services/reimbursements.ts:425` (`createReimbursementLink`)                          | `assertFeature(userId, 'reimbursements')`                                                                                                                                                                                                              |
| `lib/services/reimbursements.ts:462` (`updateReimbursementLink`)                          | Same gate (decision 2: editing counts as a new write)                                                                                                                                                                                                  |
| `lib/services/reimbursements.ts:498` (`deleteReimbursementLink`)                          | **No gate.** Links block deleting linked transactions/accounts, so blocking link deletion would trap free users' data                                                                                                                                  |
| `lib/services/trends.ts:76` (`getSpendingTrends`)                                         | `if (range > 3) assertFeature(userId, 'trendsLongRange')` (backstop)                                                                                                                                                                                   |
| `lib/services/pushSubscriptions.ts:81` (`savePushSubscription`)                           | `assertFeature(userId, 'pushReminders')`. Delete and list stay ungated                                                                                                                                                                                 |
| `lib/services/reminders.ts:123` (`updateReminderPreference`)                              | `if (input.enabled) assertFeature(userId, 'pushReminders')`. The schema always sends `enabled`, so a free user can't change cadence while enabled, and turning off is always allowed                                                                   |
| `lib/services/reminders.ts:235` (`sendDueReminders`)                                      | Skip free users (section 7)                                                                                                                                                                                                                            |
| `lib/services/emailVerification.ts:137` (`consumeVerificationToken`)                      | Replace the batch transaction with an interactive one: load the user, set `emailVerified`, delete the token, `startTrialInTx(tx, user, { now })`. `ConsumeResult` is unchanged                                                                         |
| `lib/services/passwordReset.ts:203` (`resetPassword`)                                     | When `emailVerified` was null, switch the batch transaction to an interactive one and call `startTrialInTx(tx, user, { now })` after setting it. Already-verified users keep the batch path                                                            |
| `lib/services/users.ts:66` (`findOrCreateGoogleUser`)                                     | Signature `(rawEmail, name, googleSub: string \| null)`. Existing unverified user and new user: wrap the write and `startTrialInTx(tx, user, { googleSub, now })` in one transaction. Add `isGoogleSignInAllowed(email, country)`                      |
| `lib/services/users.ts:23` (`createUser`)                                                 | **No change.** Billing requires Brevo (decision 6), so credentials users always start the trial through verification or password reset                                                                                                                 |
| `lib/services/accountDeletion.ts:48`                                                      | Outbox insert inside the transaction, then best-effort `cancelBillingForDeletion` after it (section 1)                                                                                                                                                 |
| `lib/auth/actions.ts:89` (`signUpAction`)                                                 | Country check after parse, before rate limit                                                                                                                                                                                                           |
| `lib/auth/config.ts:81-90`                                                                | New `signIn` callback (section 6); pass `account.providerAccountId` to `findOrCreateGoogleUser`                                                                                                                                                        |
| `app/api/cron/reminders/route.ts:34`                                                      | Section 7                                                                                                                                                                                                                                              |
| `app/api/accounts/route.ts:31`, `app/api/accounts/[id]/route.ts:24`                       | `PlanRequiredError` as the first catch branch                                                                                                                                                                                                          |
| `app/api/reimbursement-links/route.ts:21`, `app/api/reimbursement-links/[id]/route.ts:23` | Same                                                                                                                                                                                                                                                   |
| `app/api/transactions/route.ts:50`, `app/api/transactions/[id]/route.ts:23`               | Same                                                                                                                                                                                                                                                   |
| `app/api/push/subscribe/route.ts`, `app/api/settings/reminders/route.ts`                  | Add a try/catch around the service call: `PlanRequiredError` to 402, rethrow everything else                                                                                                                                                           |
| `app/(protected)/trends/page.tsx:55-56`                                                   | `hasFeature(userId, 'trendsLongRange')`, clamp to 3, pass `lockedRanges` to `RangePopover` (:82) and the mobile range links                                                                                                                            |
| `components/trends/range-popover.tsx`                                                     | `lockedRanges` prop                                                                                                                                                                                                                                    |
| `app/(protected)/layout.tsx:23`                                                           | Add `getPlanSummary` to the `Promise.all` (trial countdown, payment-failed banner)                                                                                                                                                                     |
| `app/(protected)/settings/page.tsx`                                                       | Pass `planSummary` to `SettingsView` (Plan section, locked reminders)                                                                                                                                                                                  |
| `components/settings/delete-account-card.tsx` (intro near :98, confirm dialog near :186)  | Shown only when `TRIAL_HASH_KEY` is set. Copy (final wording by ui-designer): "To prevent repeat free trials, we keep a one-way hash of your email address for up to 2 years. It can't be turned back into your address and isn't linked to any data." |
| `app/(auth)/signup/page.tsx`                                                              | Canada-only state from `searchParams.error` and the country header; pricing link when billing is on                                                                                                                                                    |
| `app/(auth)/login/page.tsx`                                                               | Pricing link when billing is on                                                                                                                                                                                                                        |
| `app/pricing/page.tsx`                                                                    | `notFound()` when billing is off                                                                                                                                                                                                                       |
| `lib/api-client.ts`                                                                       | `planFeatureOf(result): PlanFeature \| null` (402 and `code === 'plan_required'`)                                                                                                                                                                      |
| `lib/push/client.ts:88`                                                                   | On 402, `subscription.unsubscribe()` so the browser isn't left subscribed                                                                                                                                                                              |
| `.env.example`, `package.json` (`stripe`)                                                 |                                                                                                                                                                                                                                                        |

## 3. Error contract

```ts
export type PlanFeature =
  'accounts' | 'reimbursements' | 'statementCycles' | 'pushReminders' | 'trendsLongRange';

export class PlanRequiredError extends ServiceValidationError {
  readonly code = 'plan_required' as const;
  constructor(
    public readonly feature: PlanFeature,
    message: string,
  ) {
    super(message);
    this.name = 'PlanRequiredError';
  }
}
export class BillingDisabledError extends Error {} // billing routes: 404
export class BillingConflictError extends Error {} // already subscribed / no customer: 409
export class BillingProviderError extends Error {} // Stripe failed: 502
```

- Plan error response: **402**
  `{ "error": "<message>", "code": "plan_required", "feature": "<PlanFeature>" }`.
  402 isn't used anywhere else, and the client renders the upgrade prompt for
  `feature` instead of the error text.
- `PlanRequiredError` subclasses `ServiceValidationError`, so every route must
  check it **first**.
- Webhook: 404 when billing is off, 500 when `STRIPE_WEBHOOK_SECRET` is unset,
  400 on a bad signature, 200 `{ received: true }` for processed, duplicate or
  ignored, 500 when the handler throws (Stripe retries).

## 4. Stripe flow

**Checkout** (`createCheckoutSession`):

1. Billing off: `BillingDisabledError`.
2. Load the user and Subscription, then branch on `status`:
   - `ACTIVE`, `TRIALING`, `PAST_DUE`, `UNPAID`, `PAUSED`:
     `BillingConflictError` ("Manage your plan from the billing portal"). The
     last two still hold a live Stripe subscription, so a new Checkout would
     create a second one.
   - `INCOMPLETE`: cancel the stale `stripeSubscriptionId` first (tolerate
     `resource_missing`), then continue. Otherwise an abandoned 3-D Secure
     step would lock the user out for Stripe's 23-hour expiry.
   - `null`, `INCOMPLETE_EXPIRED`, `CANCELED`: continue.
3. Reuse `stripeCustomerId`, or create the customer with
   `metadata: { userId }` and idempotency key `tal-customer-<userId>`, then
   upsert the Subscription row.
4. Session params: `mode: 'subscription'`, `customer`,
   `client_reference_id: userId`, `metadata: { userId }`, the CAD price for the
   interval, `billing_address_collection: 'required'`,
   `customer_update: { address: 'auto', name: 'auto' }`,
   `payment_method_types: ['card']` (the country rule is about cards, so no
   Link, wallets or bank debits), `payment_method_collection: 'always'`,
   `automatic_tax: { enabled: false }`, `allow_promotion_codes: false`,
   `expires_at: now + 31 min` (Stripe's minimum is 30, the extra minute covers
   clock drift), success URL `appBaseUrl() + '/settings?billing=success'` and
   cancel URL `appBaseUrl() + '/settings?billing=cancelled'` (never the
   request Host).
5. **Trial carry-over:** if the user is in their app trial and
   `trialEndsAt(trialStartedAt)` is more than 49 hours away, set
   `subscription_data.trial_end` to it. Stripe rejects a `trial_end` under 48
   hours, so inside that window the card is charged now.

**Portal:** `BillingConflictError` without a row, otherwise a portal session
with `return_url: appBaseUrl() + '/settings'`. Plan switching, cancel at
period end, card update and invoices are configured in the Stripe dashboard.

**Webhook route:** `const raw = await request.text()` (the Next 16 way, see
`node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/route.md`,
Webhooks), never `request.json()` first. Then `constructStripeEvent` and
`handleStripeEvent`.

**Idempotency:** skip if a `StripeEvent` with the id exists. Do Stripe side
effects with idempotency keys, then write subscription changes and the
`StripeEvent` row in one transaction. P2002 on that insert means a concurrent
duplicate. If anything throws, no row is written and Stripe retries.

**Sync:** for each subscription event, re-fetch the subscription
(`expand: ['default_payment_method']`) and copy its current state instead of
trusting the event snapshot. Find the row by `stripeCustomerId`; no row means
log and ignore. `interval` and `currentPeriodEnd` come from
`items.data[0]`. `cancelAtPeriodEnd = cancel_at_period_end || cancel_at != null`.
An unknown status or a missing `items.data[0]` (API version drift) throws, so
no `StripeEvent` row is written and Stripe retries while we fix it.
**Stale-event guard:** only write when the row's `stripeSubscriptionId` is
null, matches, or the row's status isn't paid.

| Event                                        | Action                                                                           |
| -------------------------------------------- | -------------------------------------------------------------------------------- |
| `checkout.session.completed`                 | Check `client_reference_id` matches the row's user, sync, check the card country |
| `customer.subscription.created` / `.updated` | Sync                                                                             |
| `customer.subscription.deleted`              | Sync to CANCELED; the user falls back to trial or free                           |
| `invoice.payment_failed`                     | Sync (PAST_DUE), which drives the payment-failed banner; access is kept          |
| `charge.succeeded`                           | Card-country backstop                                                            |
| anything else                                | Record the `StripeEvent`, return `ignored`                                       |

**Card-country backstop:** when the card country is known and isn't `CA`,
cancel the customer's live subscriptions, refund the charge (for
`charge.succeeded`, idempotency key `tal-refund-<chargeId>`), sync, then send
the country cancellation email (decision 5). A trialing subscription has no
charge, so it's cancelled with no refund. When the country is unknown, allow
it and log a warning with the customer id (decision 4). Radar may not
evaluate no-charge trial checkouts, so this is the real control during a
Stripe trial. Subscribe the webhook endpoint to exactly these 6 events with
the pinned API version. `customer.deleted` is deliberately not one of them.

## 5. Entitlements truth table (`resolvePlan`)

Top to bottom. `trialEnd = trialStartedAt + 30 days`.

| #   | billingEnabled | subscription.status                                            | trial                                       | Plan  |
| --- | -------------- | -------------------------------------------------------------- | ------------------------------------------- | ----- |
| 1   | false          | any                                                            | any                                         | paid  |
| 2   | true           | ACTIVE, TRIALING, PAST_DUE                                     | any                                         | paid  |
| 3   | true           | none, INCOMPLETE, INCOMPLETE_EXPIRED, CANCELED, UNPAID, PAUSED | `trialStartedAt` set and `now < trialEnd`   | trial |
| 4   | true           | same as row 3                                                  | `trialStartedAt` null, or `now >= trialEnd` | free  |

- Day 0 and day 29 after `trialStartedAt` are trial; exactly 30 days and later
  are free.
- An unverified credentials user, or one whose identity already claimed a
  trial, has `trialStartedAt` null and is free. The UI tells them apart with
  `trialStatus`: `not_started` ("Verify your email to start your free month")
  vs `used` ("Your free trial was already used").
- A user who cancels stays ACTIVE with `cancelAtPeriodEnd` until
  `customer.subscription.deleted`, so stays paid until then.
- `trialDaysLeft = ceil((trialEnd - now) / day)` on trial, otherwise null.
- Paid while the app trial is still running (upgraded early): `plan` is
  `paid`, `trialStatus` is `active`, `trialDaysLeft` is null and
  `trialEndsAt` is still set, so the Plan section can say "You won't be
  charged until <date>".
- Billing off: `trialStatus`, `trialEndsAt` and `trialDaysLeft` are null.
- `getPlan` for a user id with no row returns `free`. The caller's session is
  stale, and the next service call will fail on its own.

## 6. Signup country check

- **Credentials (`signUpAction`):** after the Zod parse, before the rate limit
  and `createUser`, so a refused attempt writes nothing. Error: "Track a Loonie is only
  available in Canada." The same answer whether or not the email exists.
- **Signup page:** pre-renders the Canada-only state from the same header, so
  most visitors never see the form.
- **New Google users:** a `signIn` callback in `lib/auth/config.ts` returns
  `'/signup?error=country'` when `isGoogleSignInAllowed` is false. Existing
  users always pass, so login is never geo-checked. A `signIn` redirect is
  cleaner than throwing in `findOrCreateGoogleUser`, which runs in the `jwt`
  callback and would land on Auth.js's generic error page.
- **Missing header:** with `ALLOWED_SIGNUP_COUNTRIES` unset the check is off.
  When it's set, a missing or malformed header is refused (fails closed). A
  value with no valid code at all (for example `CAN`) refuses everyone and
  logs an error, rather than silently turning the check off.
- **Header access in the callback:** the `signIn` callback reads the country
  with `headers()` from `next/headers`, same as `signUpAction`. Confirm this
  works inside an Auth.js callback against the Next 16 docs in
  `node_modules/next/dist/docs/` before relying on it. The "is this a new
  user" lookup uses `normalizeEmail`, matching `findOrCreateGoogleUser`.
- **E2E:** set `ALLOWED_SIGNUP_COUNTRIES=CA` in the Playwright webServer env,
  default `extraHTTPHeaders: { 'x-vercel-ip-country': 'CA' }`, and override to
  `US` in the refusal spec. The Google path can't be tested end to end.

## 7. Cron

**`sendDueReminders` (`reminders.ts:235`):** after working out which prefs
are due, filter them with `listUserIdsWithFeature(dueUserIds, 'pushReminders', now)`.
`lastEvaluatedAt` still updates for every enabled pref. Add
`skippedNotEntitled` to the summary: the count of due users skipped for being
on free (not every enabled free user). Free users' prefs stay enabled so
reminders resume on upgrade.

**`sendTrialEndingEmails(now)`:** no-op unless billing and email are both
configured. Candidates (`take: 200`): `trialReminderSentAt` null,
`trialStartedAt > now - 30d` (trial still running) and
`trialStartedAt <= now - 25d` (5 days or fewer left), and no paid
subscription (include an explicit `status: null` branch, since SQL `NOT IN`
drops NULLs). A user missed for 5 straight failed runs gets no email; that's
accepted.
For each: claim with `updateMany({ where: { id, trialReminderSentAt: null } })`,
send, and reset to null on `EmailSendError` so the next run retries.

**`pruneTrialClaims(now)`:** deletes `TrialClaim` rows with
`claimedAt` older than 2 years.

**`retryStripeCustomerCleanups(now)`:** no-op when billing is off. Takes up
to 50 `StripeCustomerCleanup` rows, oldest first, and calls
`stripe.customers.del` for each. Success or `resource_missing` deletes the
row; any other error bumps `attempts` and records `lastError`. Rows past 10
attempts are logged at error level on every run.

**`app/api/cron/reminders/route.ts:34`:** run all four with
`Promise.allSettled` so one failing job doesn't block the others, and respond
`{ ...reminderSummary, trialEmails, trialClaimsPruned, stripeCleanups }`. A
rejected job's key is `{ error: true }` (details go to the log, not the
body). The status is 500 when any job rejected, so Vercel Cron shows the run
as failed, and 200 otherwise. The prune runs whether or not billing is on.

## 8. Env vars (`.env.example`)

```
# optional: enables the paid plan. Unset, billing is off: every user gets
# every feature and no plan/billing UI renders (self-hosted default).
# STRIPE_SECRET_KEY="sk_live_..."
# When STRIPE_SECRET_KEY is set, a production boot fails unless
# STRIPE_WEBHOOK_SECRET, both price ids, TRIAL_HASH_KEY and Brevo are set too.
# signing secret for /api/billing/webhook.
# STRIPE_WEBHOOK_SECRET="whsec_..."
# CAD recurring price ids for C$4/month and C$40/year
# STRIPE_PRICE_MONTHLY="price_..."
# STRIPE_PRICE_YEARLY="price_..."
# optional: comma-separated ISO country codes allowed to sign up, checked
# against Vercel's x-vercel-ip-country header. Unset, the check is off. Set, a
# missing header is refused. Only trustworthy on Vercel.
# ALLOWED_SIGNUP_COUNTRIES="CA"
# optional: blocks repeat free trials (delete and re-signup, Gmail +tag/dot
# aliases, reused Google account). Keys the HMAC-SHA256 of normalized emails
# and Google ids in TrialClaim. openssl rand -base64 32. Required when billing
# is on. Unset with billing off, nothing is checked (self-host default).
# Rotating it voids every past claim, so treat it as permanent.
# TRIAL_HASH_KEY="..."
```

## 9. Risks and decisions

**Risks:**

- Pin the Stripe `apiVersion`; field locations (period end, invoice charge)
  move between versions.
- `x-vercel-ip-country` is only trustworthy on Vercel. VPNs and travellers get
  through by design.
- Account limit is count-then-create, so two concurrent creates could make a
  3rd account. Accepted.
- Two concurrent Checkouts could create two subscriptions. Partly mitigated by
  the 31-minute expiry and the 409 for live subscriptions.
- Brevo's 300/day free limit is shared with verification and password reset
  emails; the `take: 200` cap matters.
- `StripeEvent` grows forever. Optionally prune rows older than 90 days.
- Rotating `TRIAL_HASH_KEY` voids every past claim. Add a runbook note next
  to `docs/runbooks/rotate-secret-encryption-key.md`.
- Normalization strips `+tag` on every domain, which can merge two real
  mailboxes at providers without `+` aliases. That only costs a trial.
  Outlook dots, custom domains and catch-alls aren't caught.
- With verification on the trial path, a lost link means no trial until the
  user resends it from the existing banner or resets their password.
- A Stripe customer in the cleanup outbox keeps billing until the retry
  succeeds. Stripe outages are short and the cron runs daily; a renewal
  charged in that gap is refunded by hand.
- E2E free-user tests need billing on with dummy Stripe, Brevo and
  `TRIAL_HASH_KEY` values (gates make no Stripe calls) and a seeded user
  whose trial has expired.

**Decisions (product owner, resolved 2026-10-05):**

1. Refund on account deletion: **no**, per the refund policy.
2. Free user editing an existing reimbursement link: **blocked**, it counts
   as a new write. Deleting a link stays allowed.
3. Data import (`importUserData`, `userData.ts:262`): **bypasses the gates**,
   it's a restore of the user's own data. It never touches billing or trial
   fields.
4. Card whose country Stripe can't determine: **allow and log.**
5. Subscription cancelled for a non-Canadian card: **email the user** from
   the webhook handler. No schema field.
6. Billing on without Brevo: **not allowed in production.** The boot check
   fails. So the trial-at-signup fallback in `createUser` is dropped.
7. Billing on without `TRIAL_HASH_KEY`: **not allowed in production.** Same
   boot check.
8. Zero-based budgeting (#88): **free.** It's core budgeting, no gate.
9. Account deletion when Stripe is down: **never blocked.** Outbox plus a
   daily retry (section 1).
10. `/pricing` with billing off: **404.**

## 10. Implementation checklist

- [ ] `npm i stripe`; env vars in `.env.example`
- [ ] `instrumentation.ts` boot check (`billingConfigProblems`) + tests
- [ ] Schema: enums, `Subscription`, `StripeEvent`, `TrialClaim`,
      `StripeCustomerCleanup`, `User.trialStartedAt`,
      `User.trialReminderSentAt`;
      `npm run prisma:migrate -- --name paid_plan`, `npm run prisma:generate`
- [ ] `common.ts` errors and `PlanFeature`; `lib/http/planRequired.ts`;
      `planFeatureOf` in `lib/api-client.ts`
- [ ] `lib/billing/stripe.ts`
- [ ] `entitlements.ts` + tests
- [ ] `lib/trial/normalizeEmail.ts` + tests
- [ ] `trialClaims.ts` (`startTrialInTx`, hashing, `pruneTrialClaims`) +
      tests
- [ ] `consumeVerificationToken` interactive transaction that starts the trial
- [ ] `resetPassword` starts the trial when it verifies the email
- [ ] `findOrCreateGoogleUser(rawEmail, name, googleSub)` with trial start for
      new and unverified users; pass `account.providerAccountId` from
      `config.ts:86`
- [ ] `TRIAL_HASH_KEY` rotation runbook note
- [ ] `clientCountry.ts` + tests; `signUpAction` check; `signIn` callback;
      update auth and users tests
- [ ] Gates in accounts, transactions, reimbursements, trends,
      pushSubscriptions, reminders + tests
- [ ] Route catch branches (8 routes)
- [ ] Trends page clamp and `lockedRanges`
- [ ] Push client 402 handling
- [ ] `billing.ts`, validator, 3 routes + `billing.test.ts`
- [ ] Country cancellation email builder + test
- [ ] `accountDeletion.ts` outbox and best-effort cancel, deletion copy +
      tests that deletion succeeds when Stripe fails and `TrialClaim` rows
      survive
- [ ] `trialEmails.ts`, email builder, `pruneTrialClaims`,
      `retryStripeCustomerCleanups`, cron route (500 on any failed job),
      reminders free-user skip + tests
- [ ] `/pricing` 404 with billing off
- [ ] UI per ui-designer spec, including "verify to start your trial" and
      "trial already used" states
- [ ] Privacy policy wording for `TrialClaim`: what (keyed hash of normalized
      email and Google id), why (repeat trials), how long (2 years), not linked
      to any account, survives deletion. List it in the Law 25 retention
      schedule.
- [ ] E2E config: country header default, expired-trial seed, billing-on
      project
- [ ] `npm run format:fix && npm run lint && npm run test && npm run test:e2e`
- [ ] Ops: CAD prices, portal config, Radar rule, webhook endpoint (6 events,
      pinned version), Vercel env vars
