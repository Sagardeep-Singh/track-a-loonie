# Spread expenses over time

## Problem

Some expenses are paid once but cover a longer period. An annual property tax bill paid in
June lands entirely in June, so June looks wildly over budget and the other eleven months look
cheaper than they really are. Insurance premiums, annual subscriptions and car registration
have the same problem. The user wants to say "this $3,600 payment really costs me $300 a
month for 12 months" and have the reporting reflect that.

## Scope

Mark an EXPENSE transaction as spread across N months starting at a chosen month. The real
transaction stays exactly as it is in the ledger (one row, one date, full amount). Reporting
surfaces (Budgets, Overview, Trends) replace that single hit with N equal monthly shares.

## Decisions

Locked with the owner before design:

- **Reporting only, not the ledger.** One real transaction stays in the ledger. Account
  balances, the Transactions list and its totals, the credit card cycle card and CSV dedupe
  all keep using the actual cash amount and date. Only Budgets, Overview and Trends use the
  monthly shares. No synthetic child transactions are created.
- **Window is a start month plus a month count.** The start month defaults to the
  transaction's own month but can be earlier or later, so a June payment can cover Jan to Dec
  of the same year (backward spread) or Jul to Jun of the next (forward spread).
- **Expenses only in v1.** Spreading income (annual bonus, tax refund) is a non-goal.
- **Mutually exclusive with reimbursable**, and with `isTransfer` / `isPayment`, matching the
  existing exclusion rules in `lib/validators/transactions.ts`.

Assumptions made while planning, flagged rather than silently decided:

- **Shares are derived on read, never stored.** Editing the amount, date or window of a spread
  expense just changes what the next read computes. No rows to keep in sync, no migration of
  shares, delete just works.
- **Rounding.** Work in cents. `base = floor(total / n)`, and the first `total mod n` months get
  one extra cent, so the shares always sum exactly to the transaction amount. `$100 / 3` gives
  `33.34, 33.33, 33.33`.
- **Month count range is 2 to 24.** 1 would be a no-op; 24 covers biennial bills. Easy to raise.
- **Start month must be within 24 months either side of the transaction month**, so a typo like
  year 2062 can't silently push spend into the far future.
- **Category comes from the transaction.** Recategorizing the payment moves every share.
- **Daily bars and the day panel stay cash-based, with spread rows removed.** A share isn't a
  day event, so it doesn't belong on a specific day bar. The spread payment itself contributes
  0 to its day's bar and `daySpent`, but is still listed in the day panel with a "Spread" badge
  so the user can see where the money went. Monthly figures (`hero.expense`, the pie, budget
  rings, pace) include the share for that month.
- **CSV import never sets a spread.** The user marks it afterward from the edit form. Rules and
  AI categorization are unaffected.
- **Data export/import round-trips the two new fields.**

## Schema (needs owner approval)

This feature needs a schema change. Per `CLAUDE.md`, flagging rather than assuming it's
authorized.

Two nullable columns on `Transaction`, both null for a normal transaction:

```prisma
/// first YYYYMM month (same idiom as Budget.month) this EXPENSE's cost is spread
/// over for reporting. Invariant: spreadStartMonth !== null <=> spreadMonths !== null.
/// Ledger, balances and the Transactions page ignore it; only budgets/overview/trends
/// read it. Mutually exclusive with isTransfer/isPayment/isReimbursable.
spreadStartMonth Int?
/// number of months (2-24) the amount is split evenly across, remainder cents
/// going to the earliest months. null when not spread.
spreadMonths     Int?
/// last YYYYMM month of the spread; denormalized from start + months so an
/// overlap query can use plain integer comparisons. null when not spread.
spreadEndMonth   Int?

@@index([userId, spreadEndMonth])
```

`spreadEndMonth` is denormalized because YYYYMM isn't linear (`202612 + 1` isn't `202701`), so
"which spreads overlap Mar 2026" can't be expressed as arithmetic in a Prisma `where`. The
service always writes all three together. Migration name: `add_spread_expenses`. No backfill:
existing rows are null.

## Pure helpers: `lib/spread.ts` (new)

- `addMonths(month: number, n: number): number` for YYYYMM arithmetic (could live in
  `lib/date.ts` instead; it's a natural fit there, decide at implementation).
- `spreadEndMonth(start: number, months: number): number`
- `allocateSpread(amountCents: number, start: number, months: number): { month: number; cents: number }[]`
  with the rounding rule above.

## Service: `lib/services/spreadExpenses.ts` (new)

- `listSpreadSharesInRange(userId, fromMonth, toMonth): Promise<SpreadShareRow[]>`
  - Query: `type: 'EXPENSE', isTransfer: false, spreadMonths: { not: null },
    spreadStartMonth: { lte: toMonth }, spreadEndMonth: { gte: fromMonth }`.
  - Selects `id, amount, categoryId, category.name, spreadStartMonth, spreadMonths`.
  - Returns one plain row per (transaction, month) inside the range:
    `{ transactionId, categoryId, categoryName, month, amount: string }`.
  - Note the query is by window, not by `date`, so a June payment shows up in a March read.

## Changed services

Every reporting read follows the same pattern: exclude spread rows from the existing
date-based query (`spreadMonths: null`), then add the shares from
`listSpreadSharesInRange` for the same month range. No double counting.

- **`lib/services/budgets.ts` (`listBudgets`)**: add `spreadMonths: null` to the `groupBy`,
  add shares for `month` into `spentMap` by category.
- **`lib/services/overview.ts` (`getOverviewData`)**:
  - `hero.expense` and `expenseBreakdown` (pie): skip spread rows from `transactions`, add the
    month's shares (by category, including uncategorized).
  - `dayBars` / `daySpent`: skip spread rows, add nothing (see assumption above).
  - Budget rings and pace come from `listBudgets`, so they pick it up for free.
  - `cycleCard`: unchanged, it's cash on the card.
- **`lib/services/trends.ts`**: same skip-and-add for `monthTotals` and
  `categoryMonthTotals` across `allMonths`. Movers and category totals then reflect the spread.
- **`lib/services/transactions.ts`**: `FrontendTransaction` gains
  `spread: { startMonth: number; months: number; monthlyAmount: string } | null`.
  `createTransaction` / `updateTransaction` write all three columns (or null all three) and
  enforce the DB-state checks the validator can't: on a partial PATCH, the merged
  type/isTransfer/isPayment/isReimbursable must still be compatible with a spread; turning a
  spread expense reimbursable (or vice versa) is rejected with `ServiceValidationError`.
- **`lib/services/transfers.ts`** (`matchTransfers`): exclude spread rows from auto-matching
  candidates. A spread expense is by definition real spending, not a transfer leg.
- **`lib/services/reimbursements.ts`**: no change. The two features are mutually exclusive
  and the validator plus service guards keep it that way.
- **`lib/services/userData.ts`**: export and import `spreadStartMonth` / `spreadMonths`,
  recompute `spreadEndMonth` on import rather than trusting the file.
- **`lib/services/transactionsPage.ts`**: no aggregate change (stays cash). Add `spread` to the
  row select so the list can show a badge.

## Validators: `lib/validators/transactions.ts`

Add to `transactionFieldsSchema`:

```ts
spreadStartMonth: yyyymmSchema.nullable().optional(),
spreadMonths: z.coerce.number().int().min(2).max(24).nullable().optional(),
```

New `refineSpread` cross-field check (applied to create and the partial update, like
`refineReimbursable`):

- both set or both null
- `type` must be EXPENSE when set
- not combined with `isTransfer`, `isPayment` or `isReimbursable`
- start month within 24 months of `date`'s month when both are in the payload

## API routes

No new routes. The existing transaction create/update handlers already pass validated input to
the service; they only need the new fields to flow through.

## Frontend

- **`components/transactions/transaction-form.tsx`**: for EXPENSE only, a "Spread over time"
  switch. When on: a start month picker (default: the transaction's month) and a month count
  input (default 12). A live preview line: "$300.00 a month, Jan 2026 to Dec 2026". The switch
  is disabled with a hint when the expense is reimbursable, a transfer or a payment (and the
  reimbursable switch is disabled the same way when spread is on).
- **Transactions list (`transactions-view.tsx`)**: small "Spread, 12 mo" badge on the row.
- **Overview day panel**: the same badge on a spread payment, so it's clear why it isn't in
  that day's bar.
- **Budget card / pie drilldowns**: these link to the Transactions page for the month, which
  is cash-based and won't list a payment dated in another month. See open question 1.
- ui-designer spec to follow once the schema is approved.

## Open questions

1. **Drilldown mismatch.** Clicking the "Property tax" budget card for March links to
   Transactions filtered to March, but the payment is dated June. Options: (a) leave it, the
   Transactions page is the ledger; (b) show a "Includes $300.00 spread from 1 transaction"
   note on the drilldown with a link to the source payment; (c) add a "spread into this month"
   section on the Transactions page. Leaning (b).
2. **Should the Overview show a cash vs spread hint?** E.g. a small "Includes $300 of spread
   expenses" line under `hero.expense`. Not needed for v1 but cheap.
3. **Month count range.** Is 2 to 24 enough, or should it go to 36/60 for multi-year items?

## Non-goals (this iteration)

- Spreading income.
- Spreading a reimbursable expense (net of reimbursement).
- Custom uneven splits or day-level (daily accrual) spreading.
- Auto-detecting annual bills or suggesting a spread.
- Recurring spreads (next year's bill is a new transaction, marked again).
- A cash vs spread toggle on Overview/Trends.

## Test plan (summary, full plan from tester before implementation)

Unit (`tests/unit/...`):

- `lib/spread.ts`: `addMonths` across year boundaries and backward; `allocateSpread` sums to
  total, remainder cents go to earliest months, 2 and 24 month edges, amount smaller than
  month count in cents.
- Validator: both-or-neither, EXPENSE only, exclusion with transfer/payment/reimbursable,
  bounds on months and start month, partial update cases.
- `spreadExpenses.ts`: overlap query picks up backward, forward and year-crossing spreads,
  ignores other users, ignores non-spread rows.
- `budgets.ts`, `overview.ts`, `trends.ts`: a $3,600 June payment spread Jan to Dec shows $300
  in March and $300 (not $3,600) in June; no double counting; day bars exclude it.
- `transactions.ts`: create/update writes all three columns, clearing a spread nulls all three,
  PATCH that turns a spread expense into income or reimbursable is rejected.
- `userData.ts`: export/import round-trip, `spreadEndMonth` recomputed on import.

e2e (`tests/e2e/spread-expenses.spec.ts`):

- Create an expense, turn on spread, see the preview, save; the Budgets page for a covered
  month shows the share; the payment's own month shows only the share.
- Turn spread off again and totals revert.
- Reimbursable and spread can't both be on.
- Validation error for an out-of-range month count.

## Checklist

- [ ] Owner approves the schema change and answers the open questions
- [ ] product-manager pass on user stories and acceptance criteria
- [ ] software-architect review of this plan
- [ ] ui-designer spec for the form section, badges and drilldown note
- [ ] tester writes the full unit and e2e test plan
- [ ] `prisma/schema.prisma`: `spreadStartMonth`, `spreadMonths`, `spreadEndMonth` + index
- [ ] Migration `add_spread_expenses` + `npm run prisma:generate`
- [ ] `lib/spread.ts` (or `lib/date.ts`): `addMonths`, `spreadEndMonth`, `allocateSpread`
- [ ] `lib/validators/transactions.ts`: new fields + `refineSpread`
- [ ] `lib/services/spreadExpenses.ts`: `listSpreadSharesInRange`
- [ ] `lib/services/transactions.ts`: `spread` on `FrontendTransaction`, write path, DB-state guards
- [ ] `lib/services/budgets.ts`: exclude spread rows, add shares
- [ ] `lib/services/overview.ts`: hero/pie use shares, day bars/daySpent skip spread rows
- [ ] `lib/services/trends.ts`: month and category totals use shares
- [ ] `lib/services/transfers.ts`: exclude spread rows from matching
- [ ] `lib/services/userData.ts`: export/import new fields
- [ ] `lib/services/transactionsPage.ts`: select spread fields for the badge
- [ ] UI: transaction form spread section, list and day panel badges, drilldown note
- [ ] Unit tests for helpers, validator and changed services
- [ ] e2e: `tests/e2e/spread-expenses.spec.ts`
- [ ] `npm run format:fix && npm run lint`, `npm run test`, `npm run test:e2e`
