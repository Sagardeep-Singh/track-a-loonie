# Transfer auto-matching

## Problem

Paying a credit card from checking creates two transactions: an EXPENSE on checking
("Payment to Visa") and an INCOME on the card. The card side already carries
`isPayment`, which `lib/services/overview.ts` uses to keep it out of the dashboard's
"In" total. The checking-side EXPENSE has no equivalent gate, so it is counted as real
spending — double-counting the payment on top of the card purchases it settles.

Both legs of an inter-account transfer should drop out of income/expense aggregates,
and matching pairs should be detected automatically rather than hand-flagged.

## Decisions

- **Two low-ceremony fields, modeled on `isPayment`.** `isTransfer Boolean @default(false)`
  on both legs; `transferMatchId String?` as a soft correlation id (indexed, no FK) shared
  by a matched pair. This app is not a strict double-entry ledger — a join table with hard
  FKs buys nothing here.
- **`isTransfer` and `isPayment` are independent.** The income side of a card payment can
  legitimately be both; every gate keeps its existing `!t.isPayment` and adds `!t.isTransfer`.
- **5-day match window.** Bank/card postings for the same payment routinely land 1-3 days
  apart; 5 days absorbs a weekend plus a holiday without reaching far enough to collide with
  the next month's identically-sized payment.
- **No account-type assumption.** Checking -> checking transfers match too; nothing requires
  `CREDIT_CARD`.
- **Decimal equality via `Number(amount).toFixed(2)`** — Decimals are never compared with
  `===`; this matches how the rest of the services coerce money.
- **Aggregates exclude transfers; balances do not.** A transfer genuinely moves money, so
  `cycleCard`'s account balance (`overview.ts`) and the running balance in
  `transactions-view.tsx` still count both legs. Only spend/income aggregates gate on
  `isTransfer`.
- **`cycleSpend` gates on `isTransfer`.** It is labelled cycle _spend_, so a transfer out of
  the card is not spending. (`isPayment` has no gate there today because payments are INCOME
  and the sum is EXPENSE-only — it was never reachable.)
- **`isPayment` is checked before `isTransfer` in the transactions summary.** A card payment is
  both once matching runs; keeping `isPayment` first means the existing "Payments (excluded)" chip
  behaves exactly as it does today, and "Transfers (excluded)" picks up only the non-payment
  transfers (e.g. checking -> savings). Both buckets are excluded from credit/debit/net either way.
- **Budget spend gates on `isTransfer` too.** `listBudgets`' `groupBy` sums categorized EXPENSE
  rows; a categorized transfer leg would otherwise inflate `hero.spent` and the budget rings while
  `hero.expense` excluded it — same dashboard, contradicting numbers. (`isPayment` needs no gate
  there: payments are INCOME and the sum is EXPENSE-only.)
- **Un-marking unlinks the whole pair.** `PATCH /api/transactions/:id` with `isTransfer: false`
  clears the row's flag and `transferMatchId`, and in the same database transaction clears both
  on every other row sharing that `transferMatchId`. No leg is left half-excluded, and both can
  be re-matched later. A hand-flagged transfer with no `transferMatchId` only un-marks itself.

## Scope found in this worktree (deviation from brief)

The brief references a spending-by-category pie chart (`expenseBreakdown` in
`lib/services/overview.ts`, `components/dashboard/expense-pie.tsx`). **Neither exists on this
branch** (branched from `origin/main`); `components/dashboard/` holds only `period-popover.tsx`.
Not built here. Whoever merges the pie chart must add `&& !t.isTransfer` to its expense sum.

`lib/services/csvImport.ts` is the pre-refactor version here; the import-batch-tracking branch
rewrites it. The `matchTransfers` call added at the end of `commitImport` is an expected merge
conflict.

**The migration was written by hand, not applied.** `prisma migrate dev` refused: the shared local
dev database already has `20260910090243_add_import_batch` applied (from the import-batch branch)
and that migration is not in this branch's history, so Prisma reported drift and offered a reset —
declined. `prisma/migrations/20260910120000_add_transfer_matching/migration.sql` is the SQL Prisma
would have produced (additive `ADD COLUMN` + index, no backfill); `prisma generate` was run so the
client and types are current. Apply it with `npm run prisma:migrate` (or `prisma migrate deploy`)
once the branches are on a common migration history.

**Consequence while the migration is unapplied:** `prisma generate` writes into the repo-root
`node_modules`, which every worktree shares, and the generated client now selects the two new
columns on any `Transaction` query. Until the SQL above is applied, transaction queries fail with
`column Transaction.isTransfer does not exist` — in this branch _and_ in any other checkout using
that `node_modules`. Remedy: apply the migration, or run `npm run prisma:generate` from the other
checkout to roll its client back.

## Implementation

### Schema — `prisma/schema.prisma`, `Transaction`

- `isTransfer Boolean @default(false)` (doc comment), `transferMatchId String?`,
  `@@index([transferMatchId])`. Migration `add_transfer_matching`, purely additive.

### `lib/services/transfers.ts` (new)

- `matchTransfers(userId): Promise<{ matched: number }>` — loads this user's transactions with
  `isTransfer: false`, splits into EXPENSE and INCOME, and greedily pairs each EXPENSE with the
  nearest-date INCOME candidate that is on a **different account**, has an **equal amount**, and
  falls within 5 days. Each side is consumed at most once per run. A match writes
  `isTransfer: true` plus a shared `randomUUID()` `transferMatchId` to both rows in one
  `prisma.$transaction([...])`.
- Runs at the end of `commitImport` and on demand via `POST /api/transactions/match-transfers`.
  The `commitImport` call is wrapped in try/catch: the rows are already committed by then and
  matching can be re-run from the transactions screen, so a matching failure must not surface as
  an import failure.

### Aggregate gates — `lib/services/overview.ts`

`hero.income`, `hero.expense`, the `dayMap` income/expense buckets, `daySpent`, and `cycleSpend`
all gain `&& !t.isTransfer`. `selectedDay.rows` and the transaction list keep showing transfers —
they happened, they just are not spending.

### UI

- `components/transactions/transaction-form.tsx`: `isTransfer` checkbox, ungated by account/type
  (either leg, any account).
- `components/transactions/transactions-view.tsx`: "Match transfers" button hitting the new route
  and reporting the count; a `transfers` bucket in the summary reducer mirroring the existing
  "Payments (excluded)" treatment. No per-row badge — `isPayment` has none today.

## Checklist

- [x] `prisma/schema.prisma`: `isTransfer`, `transferMatchId`, index
- [x] Migration `add_transfer_matching` + `prisma generate`
- [x] `lib/services/transfers.ts` with `matchTransfers`
- [x] `lib/validators/transactions.ts`: `isTransfer` on create/update
- [x] `lib/services/transactions.ts`: carry `isTransfer` through create/update/`FrontendTransaction`;
      clear `transferMatchId` when un-marked
- [x] `commitImport` calls `matchTransfers`
- [x] `POST /api/transactions/match-transfers` route
- [x] `overview.ts` aggregate gates
- [x] `budgets.ts` spend `groupBy` gates on `isTransfer: false`
- [x] `transaction-form.tsx` checkbox
- [x] `transactions-view.tsx` button + transfers summary bucket
- [x] Unit tests: `tests/unit/services/transfers.test.ts`, extend `overview.test.ts`,
      `transactions.test.ts`, `csvImport.test.ts`
- [x] `npm run format:fix && npm run lint && npm run test`, `npx tsc --noEmit`, `npm run build`
- [ ] Apply the migration once branch histories converge, then verify end-to-end by hand
      (no e2e spec added: the existing Playwright suite needs a running app and database)
