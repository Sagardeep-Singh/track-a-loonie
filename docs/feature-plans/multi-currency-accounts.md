# Multi-currency accounts (CAD/USD)

Status: requirement spec. Nothing here is built yet; every schema change below is a proposal that
needs the owner's approval before implementation.

## Problem

Many Canadians hold a US-dollar account or card (cross-border shopping, US subscriptions,
travel, a USD savings account). Today every amount is treated as one unnamed currency, and
`components/ui/money.tsx` formats everything with `currency: 'USD'` (which renders as "$"). So:

- A USD card's balance is added straight into a CAD net worth.
- USD spending counts 1:1 against CAD budgets, which understates it by roughly 35%.
- Transfers between a CAD chequing and a USD account never auto-match, because the two legs
  have different amounts.

## Users and stories

1. As a user, I set a currency on each account (default CAD), and the app shows that account's
   balances and transactions in its own currency.
2. As a user, I pick a home currency (default CAD), and every cross-account total (dashboard,
   budgets, Trends, net worth, zero-based) is shown in it.
3. As a user, a USD transaction counts against my budgets at its home-currency value on the
   transaction date.
4. As a user, I can override the converted amount of a transaction (to match what my card
   actually charged, fees included).
5. As a user, a transfer from CAD chequing to my USD account still pairs up as a transfer when
   the converted amounts are close.
6. As a user, CSV import into a USD account just works; amounts are read as USD.

## Scope (v1)

- Currencies: CAD and USD only, behind a list that can grow.
- **Account.currency** (ISO 4217), set at creation. It can't change once the account has
  transactions.
- **User home currency**, CAD by default. Changing it is allowed and recomputes on read.
- **FX rates:** daily USD→CAD rates from the Bank of Canada Valet API (free, no key), stored
  per date. Fetched by the existing Vercel cron. A missing date (weekend or holiday) uses the
  most recent earlier rate.
- **Per-transaction home amount:** computed from the rate on the transaction date unless the
  user overrides it. Stored, so reports don't shift when rates are backfilled.
- **Display:** `Money` takes a `currency` prop. Ledger rows in a foreign account show the native
  amount with the home amount underneath ("US$40.00 · ≈ C$54.80").
- **Aggregates** (budgets, overview, Trends, zero-based, reimbursements, net worth) sum home
  amounts.

## Non-goals (v1)

- Currencies other than CAD and USD.
- Realized or unrealized FX gain/loss reporting.
- Investment holdings priced in other currencies (balance-tracked accounts take a currency but
  their updates are entered in that currency and converted the same way).
- Intraday rates.

## Acceptance criteria

- A US$100.00 expense on 2026-11-20 with a BoC rate of 1.3950 stores a home amount of C$139.50
  and adds C$139.50 to its category's budget spend.
- An override of C$142.10 replaces the computed value everywhere and is kept if rates are
  re-fetched.
- A USD account's Accounts-page balance shows in USD, and net worth shows its CAD value at
  today's rate.
- `matchTransfers` pairs a C$1,395.00 chequing expense with a US$1,000.00 income on the USD
  account dated within the window when the home amounts are within 2%.
- Existing data migrates to CAD with home amount = amount, so every number on every screen is
  unchanged for a user who never adds a USD account.
- Data export includes currency and home amount; import restores them.
- The rate fetch is best-effort: if the BoC API is down, transactions save with a null home
  amount, show "rate pending", and are filled in on the next successful fetch.

## Proposed design

### Schema (needs approval)

```prisma
model Account {
  // ...
  currency String @default("CAD") /// ISO 4217
}

model Transaction {
  // ...
  homeAmount         Decimal? @db.Decimal(12, 2) /// null = rate pending
  homeAmountOverride Boolean  @default(false)
}

model FxRate {
  id    String   @id @default(cuid())
  base  String   /// "USD"
  quote String   /// "CAD"
  date  DateTime /// UTC midnight
  rate  Decimal  @db.Decimal(12, 6)
  @@unique([base, quote, date])
}
```

Plus `homeCurrency String @default("CAD")` on a user settings row (`UserBudgetSettings` or a new
`UserPreferences`). Migration backfills `homeAmount = amount` for every existing row.

### Services

- `lib/services/fxRates.ts`: `rateOn(base, quote, date)`, `fetchBankOfCanadaRates(from, to)`
  (plain `fetch`, same style as `lib/email/brevo.ts`), `backfillPendingHomeAmounts()`.
- Every service that sums `amount` across accounts switches to `homeAmount`. The account
  balance on a single account keeps `amount` (native).
- `createTransaction`, `updateTransaction` and `commitImport` set `homeAmount` (same currency =
  amount; else amount × rate).
- `matchTransfers` compares home amounts within a tolerance when the legs' currencies differ.

### Cron

`/api/cron/fx-rates`, daily, protected by `CRON_SECRET` like the reminders cron. The Bank of
Canada host has to be added to the network allowlist in deployment.

### UI

- Account form: currency select (locked once there are transactions).
- Settings: home currency.
- `Money` gets a `currency` prop; foreign rows show both amounts; the transaction form shows the
  converted amount with an "Edit" link for the override.

## Open questions

1. Is the Bank of Canada daily rate acceptable as the source, or should users enter their own?
2. Should the override be per transaction only, or also a per-account card markup (for example
   +2.5%)?
3. Budgets in a foreign currency (a USD "Travel" budget), or always home currency?
4. Transfer-match tolerance: 2% OK?

## Checklist

- [ ] Owner approves scope, open questions and schema
- [ ] Architect pass: list every aggregate that moves to `homeAmount`, migration plan, cron
- [ ] UI spec: account currency, Money component, transaction form override
- [ ] Test plan (unit: rate lookup, conversion, matching tolerance, aggregates parity;
      e2e: USD account, budget impact, override)
- [ ] Schema + migration with backfill
- [ ] FX service + cron + tests
- [ ] Write paths set `homeAmount`
- [ ] Aggregates switch to `homeAmount`, with parity tests for CAD-only users
- [ ] UI
- [ ] Export/import support
- [ ] Tester review
