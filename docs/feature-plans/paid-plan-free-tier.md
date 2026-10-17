# Paid plan with a free tier (Canada)

## Status

Scoped, architected and test-planned. Every open decision was resolved on
2026-10-05. Next: ui-designer spec, then implementation. Nothing here is
implemented.

## Goal

Keep Track a Loonie free for everyday budgeting and add one paid plan that covers
hosting costs. The app is for Canadian users only, priced in CAD, with
payments through Stripe directly (no merchant of record).

## Decisions

Locked by the product owner:

1. **Price:** C$4/month or C$40/year.
2. **No existing users** to migrate or grandfather.
3. **Trial:** every new account gets 1 month of paid features for free.
4. **History:** unlimited for every plan. No history window.
5. **Trends:** free tier gets the 3-month view only. 6 and 12 months are paid.
6. **Canada only:** non-Canadian users are blocked at signup and at checkout.
7. **Payments:** Stripe.
8. **One trial per person:** deleting an account and signing up again does
   not give a second trial. The trial starts only once the email is verified.
9. **Zero-based budgeting is free.** It's core budgeting, like monthly
   budgets.
10. **Billing never blocks account deletion.** If Stripe is down, the account
    is still deleted and the Stripe cancel is retried by the daily cron.
11. **No refund on account deletion.** The refund policy says so.
12. **Billing needs Brevo and `TRIAL_HASH_KEY`.** A production deploy with
    Stripe on and either missing fails to boot.

The architecture doc (section 9) has the smaller technical decisions.

## Pricing

| Plan    | Price | Net after Stripe (about 2.9% + C$0.30) |
| ------- | ----- | -------------------------------------- |
| Free    | C$0   | -                                      |
| Monthly | C$4   | about C$3.58                           |
| Yearly  | C$40  | about C$38.54 (2 months free)          |

The yearly plan is the one to push. Fees drop from about 10% to about 4%.

### Running costs and break-even

| Item                                 | Monthly (CAD, rough)   |
| ------------------------------------ | ---------------------- |
| Vercel Pro (Hobby is non-commercial) | about C$28             |
| Postgres (Supabase, Neon, Prisma)    | C$0 to C$28            |
| Brevo email (free tier, 300/day)     | C$0                    |
| Domain                               | about C$2              |
| **Total**                            | **about C$35 to C$60** |

Break-even is about 10 to 17 paying users. At a typical 2 to 5% free-to-paid
conversion that means roughly 200 to 850 active free users. Marginal cost
per user is close to zero because AI categorization uses the user's own key.

## Free vs paid

| Feature                                                                | Free          | Paid (and trial) |
| ---------------------------------------------------------------------- | ------------- | ---------------- |
| Manual transactions, CSV import, import undo                           | Yes           | Yes              |
| Bank CSV presets (RBC, TD, Scotia, BMO, CIBC, Tangerine, Wealthsimple) | Yes           | Yes              |
| Categories, rules, Categorize queue                                    | Yes           | Yes              |
| Monthly budgets, Overview, drilldowns                                  | Yes           | Yes              |
| Zero-based budgeting                                                   | Yes           | Yes              |
| Transfer matching                                                      | Yes           | Yes              |
| AI suggestions (BYOK)                                                  | Yes           | Yes              |
| Full transaction history                                               | Yes           | Yes              |
| Data export, account deletion                                          | Yes, always   | Yes              |
| Accounts                                                               | 2             | Unlimited        |
| Spending trends                                                        | 3-month range | 3, 6, 12 months  |
| Reimbursable expenses                                                  | No            | Yes              |
| Credit card statement cycles                                           | No            | Yes              |
| Push reminders                                                         | No            | Yes              |

Principles:

- Never gate export or deletion. It's a trust signal, and AGPLv3 lets anyone
  self-host anyway. We sell hosting and convenience.
- Never delete or hide data when a trial or subscription ends. Anything made
  while paid stays visible. Over-limit accounts stay usable; only creating new
  ones is blocked. Existing reimbursement links and statement days stay
  readable, but new ones can't be added.
- Self-hosted installs get everything. Billing is off when `STRIPE_SECRET_KEY`
  is unset, the same way AI categorization disappears without
  `SECRET_ENCRYPTION_KEY`. The country check is off when
  `ALLOWED_SIGNUP_COUNTRIES` is unset. With billing off, `/pricing` returns 404.
- Data import is a restore, so it bypasses the plan gates. Importing 5
  accounts on the free tier works; creating a 6th by hand doesn't.

## Trial

- App-side trial with no card required. It lasts 30 days from when it starts.
- The trial starts when the email is verified. That happens in one of three
  ways: a credentials user clicks the verify link, a credentials user
  completes a password reset (the reset link proves the mailbox too), or a
  Google user signs up (Google already verified the address). Until then the
  user is on the free tier.
- During the trial the user has every paid feature.
- Upgrading during the trial creates the Stripe subscription with
  `subscription_data.trial_end` set to the app trial end, so the user isn't
  charged until their free month is over. Stripe needs at least 48 hours of
  trial, so in the last 2 days the card is charged right away.
- Email reminder 5 days before the trial ends, sent by the existing daily cron
  via Brevo. One reminder only.
- When the trial ends without a subscription, the user drops to free with all
  data kept.

## One trial per person

Account deletion removes the `User` row, and data export/import makes
"export, delete, sign up again, import" quick. To stop repeat trials:

- **`TrialClaim` table** with no relation to `User`, so it survives account
  deletion. Stores `emailHash`, an optional `googleSubHash` and `claimedAt`.
- **Keyed hash, never the email.** HMAC-SHA256 with a server secret
  (`TRIAL_HASH_KEY`). A plain SHA-256 of an email can be reversed by guessing
  addresses; an HMAC can only be checked against an address we already have.
  The key is required when billing is on. With billing off (self-hosting) the
  check is off.
- **Normalize before hashing** so aliases match: lowercase, trim, strip a
  `+tag` from the local part, and drop dots in the local part for gmail.com
  and googlemail.com (treated as the same domain).
- **Google signups** also hash Google's stable account id (`sub`), since the
  email on a Google account can change.
- **When the trial starts,** write the claim in the same transaction. If the
  email or Google id already has a claim, the user gets no trial and starts on
  the free tier.
- **Verified email required** for the trial (see Trial). Without this, fake
  addresses would give unlimited trials, since verification doesn't gate
  access today.
- **Not in v1:** blocking disposable email domains. The lists go stale and
  often flag privacy relays (SimpleLogin, Firefox Relay, iCloud Hide My
  Email). It can be added later as a trial-only check.
- **Not used:** IP, device or card fingerprints. Households share IPs,
  fingerprinting adds privacy risk, the trial needs no card, and the most
  anyone can gain is C$4 a month.
- **Privacy:** a hash kept after deletion is still personal information.
  State it in the privacy policy (purpose: fraud prevention), mention it on
  the account deletion confirmation, and delete `TrialClaim` rows older than 2
  years from the daily cron.

## Canada-only enforcement

No check is perfect (VPNs, travellers). The aim is to stop casual non-Canadian
signups and make sure every payment comes from a Canadian card.

- **Signup:** read the `x-vercel-ip-country` header (set by Vercel on every
  request) in a new `lib/http/clientCountry.ts`, alongside
  `lib/http/clientIp.ts`. Refuse new accounts when the country isn't in
  `ALLOWED_SIGNUP_COUNTRIES` (`CA`). Applies to both
  `signUpAction` (credentials) and new Google users (a `signIn` callback,
  see the architecture doc). Show a clear "Track a Loonie is only available
  in Canada" message.
- **Login:** not geo-checked. Existing users travelling abroad can still sign
  in.
- **Checkout:** cards only, require a billing address in Stripe Checkout,
  and add a Stripe Radar rule `Block if :card_country: != 'CA'`. Custom Radar
  rules may need Radar for Fraud Teams (extra per-transaction fee), so
  confirm in the Stripe dashboard. As a backstop, the webhook handler cancels
  and refunds any subscription whose card country isn't `CA`, and emails the
  user to say why. A card with no known country is allowed and logged.
- **Local dev and e2e:** the header is missing outside Vercel. With
  `ALLOWED_SIGNUP_COUNTRIES` unset the check is off. When it's set, a missing
  header is refused, so e2e sends `x-vercel-ip-country` explicitly.

## User stories

1. As a new Canadian user, I can sign up with no card and get every paid
   feature for a month once I verify my email.
2. As a visitor outside Canada, I see that Track a Loonie is only available
   in Canada and can't create an account.
3. As a trial user, I get an email 5 days before my trial ends, and I can
   subscribe without losing the rest of my free month.
4. As a free user, when I hit a paid feature or a limit, I see what the paid
   plan adds and a clear upgrade button, not an error.
5. As a free user, I can upgrade from Settings and pay with Stripe Checkout,
   monthly or yearly.
6. As a paid user, I can change plan, update my card, see invoices and cancel
   from the Stripe Customer Portal.
7. As a paid user who cancels, I keep paid features until the period ends,
   then drop to free with my data intact.
8. As a paid user whose payment fails, I see a banner asking me to update my
   card and keep access during Stripe's retry window.
9. As a paid user, I can delete my account even when Stripe is having a bad
   day, and my subscription still gets cancelled.

## Acceptance criteria

- [ ] New users have paid features for 30 days from email verification
      (verify link, password reset or Google signup) with no card. Unverified
      users are on the free tier.
- [ ] A user whose normalized email or Google id already claimed a trial,
      including on a deleted account, starts on the free tier.
- [ ] Deleting an account keeps its `TrialClaim` row, and the deletion
      confirmation says a one-way hash is kept for fraud prevention.
- [ ] `TrialClaim` stores only HMAC hashes, never a plain email or Google id.
- [ ] The daily cron deletes `TrialClaim` rows older than 2 years.
- [ ] Signup (credentials and new Google users) is refused when the request
      country isn't Canada and the check is enabled. Login is never
      geo-checked.
- [ ] Free users can't create a 3rd account. The API returns a typed plan
      error and the UI shows an upgrade prompt.
- [ ] Free users get Trends for the 3-month range. Asking for 6 or 12 months
      returns a plan error at the service layer, and the UI shows the longer
      ranges as locked.
- [ ] Reimbursement linking, statement-day settings and push reminder setup
      are blocked for free users at the service layer, not just hidden in the
      UI.
- [ ] Data created while paid or on trial stays readable after dropping to
      free.
- [ ] Transaction history and CSV export are complete for every plan.
- [ ] The reminders cron skips push reminders for free users and sends the
      trial-ending email once per user.
- [ ] Upgrading during the trial doesn't charge until the trial ends.
- [ ] Plan status updates only from verified Stripe webhooks, and each event is
      processed once (idempotent).
- [ ] A subscription paid with a non-Canadian card is cancelled and refunded,
      and the user gets an email saying why.
- [ ] Account deletion succeeds when Stripe is unreachable, and the Stripe
      customer is deleted by a later cron run.
- [ ] A production deploy with `STRIPE_SECRET_KEY` set fails to boot when the
      webhook secret, a price id, `TRIAL_HASH_KEY` or Brevo is missing.
- [ ] With Stripe env vars unset, every user is treated as paid, no billing
      UI renders and `/pricing` is a 404.
- [ ] Zero-based budgeting works the same on every plan.

## Technical outline

See `paid-plan-free-tier-architecture.md` for the full design: schema, file
breakdown with gate placement, error contract, Stripe flow, entitlements
truth table, country check, cron changes, env vars, risks and the
implementation checklist.

## Canada specifics

Not legal or tax advice. Confirm with an accountant before launch.

- **GST/HST:** small supplier until taxable sales pass C$30,000 over four
  consecutive quarters. Start with Stripe Tax off and turn it on when
  registered.
- **Provincial tax:** BC, Saskatchewan, Manitoba and Quebec (QST) have their
  own rules for software and digital services. Check before scaling.
- **Privacy:** PIPEDA applies, plus Alberta and BC PIPA. Quebec Law 25 needs a
  named privacy officer and a privacy impact assessment before personal data
  leaves Quebec.
- **Hosting:** move Postgres to a Canadian region (for example ca-central-1)
  before launch. Separate runbook in `docs/runbooks/`.

## Tests

- Unit (`tests/unit/services/`):
  - `entitlements.test.ts`: free, trial (day 0, day 29, day 31) and paid per
    subscription status, billing disabled, account limit, each feature gate.
    The Trends range gate is tested in `trends.test.ts`.
  - `billing.test.ts`: each webhook event maps to the right subscription state,
    duplicate events are no-ops, unknown events are ignored, non-Canadian card
    is cancelled and refunded, checkout carries the trial end.
  - Country check: allowed, blocked, header missing, check disabled; new vs
    existing Google user.
  - `trialClaims.test.ts`: normalization cases (case, whitespace, `+tag`,
    Gmail dots, googlemail.com), HMAC stability, trial starts only once per
    identity, claim survives account deletion, no trial when key is unset,
    retention purge.
  - Gate tests added to the existing service tests for accounts,
    reimbursements, trends and reminders, plus the one-time trial email.
  - Trial start from `consumeVerificationToken`, `resetPassword` and
    `findOrCreateGoogleUser`.
  - Account deletion with Stripe failing still deletes, and the cleanup
    retry clears the outbox.
- Full case lists are in `paid-plan-free-tier-test-plan.md`.
- E2E (`tests/e2e/`):
  - New user verifies email, then sees trial status and can use paid
    features.
  - User deletes their account and signs up again with the same email (or a
    `+tag` alias) and gets no trial.
  - Signup from a non-Canadian country is refused.
  - Free user hits the account limit and sees the upgrade prompt.
  - Free user sees 6 and 12 month Trends locked.
  - Paid user (seeded) can use every gated feature.
  - Billing disabled shows no plan UI.

## Rollout checklist

- [x] Resolve open questions
- [x] software-architect: confirm schema and gate placement
- [ ] ui-designer: Plan section, upgrade prompt, locked Trends ranges, trial
      countdown, pricing page, Canada-only signup state, banner
- [x] tester: unit and e2e test plans (`paid-plan-free-tier-test-plan.md`)
- [ ] Schema migration for `Subscription`, `StripeEvent`, `TrialClaim`,
      `StripeCustomerCleanup`, `User.trialStartedAt` and
      `User.trialReminderSentAt`
- [ ] Boot check: billing requires webhook secret, prices, `TRIAL_HASH_KEY`
      and Brevo
- [ ] `entitlements.ts` + `PlanRequiredError` with tests
- [ ] Signup country check with tests
- [ ] `TrialClaim` + trial start on verification, password reset and Google
      signup with tests
- [ ] Deletion confirmation copy about the kept hash
- [ ] `TrialClaim` retention sweep in the daily cron
- [ ] Gates in existing services with tests
- [ ] `billing.ts` + checkout, portal and webhook routes with tests
- [ ] Non-Canadian card cancellation email
- [ ] Account deletion outbox and Stripe cleanup retry in the daily cron
- [ ] Trial-ending email in the daily cron
- [ ] Settings Plan section, upgrade prompts and trial countdown
- [ ] Pricing page
- [ ] Payment failed banner
- [ ] Reminders cron skips free users
- [ ] Privacy policy, terms and refund policy pages
- [ ] Move database to a Canadian region
- [ ] Upgrade Vercel to Pro
- [ ] Stripe products and prices in CAD, Radar card-country rule, webhook
      endpoint in live mode
