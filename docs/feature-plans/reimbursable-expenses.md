# Reimbursable expenses

## Problem

An expense the user expects to be paid back for (a work expense, a split bill) is
indistinguishable today from any other expense. There's no way to flag it, say how much is
expected back, track partial repayments as they arrive, or see at a glance how much is still
outstanding.

## Scope

Mark an EXPENSE transaction reimbursable with an expected amount (which may be less than the
expense's own amount — partial reimbursement). Link INCOME transactions to it as repayments
arrive, each with its own amount (many-to-many: one paycheck can partially repay several
expenses; one expense can be repaid by several incomes over time). Status (pending / partial /
complete) is derived from the linked total vs. the expected amount, with a manual "mark fully
reimbursed" override for cases with no traceable transaction (cash handed back). A summary of
all-time outstanding reimbursement shows on the Accounts page.

## Decisions

Locked by product discussion before design (not open for the implementer to revisit):

- **Manual link + auto-suggest, never silent auto-link.** The user links income to a reimbursable
  expense from a picker. The picker ranks likely candidates (amount closeness to what's still
  outstanding, date on/after the expense, optional payee similarity) but nothing links without
  explicit confirmation — unlike `matchTransfers`, which pairs and writes automatically.
- **Reimbursement income is excluded from income/net totals**, the same treatment `isTransfer`/
  `isPayment` already get in `overview.ts` and `trends.ts`. It's the user's own money coming back,
  not new income. The gate keys off live link existence (`_count.reimbursementIncomeLinks === 0`),
  not a static column, so it starts/stops applying as links are created or removed.
- **Many-to-many with a per-link amount.** Needs a real join table (`ReimbursementLink`) with its
  own `amount` — not a soft correlation id like `transferMatchId`, because the relationship
  carries money and isn't 1:1.
- **Deleting a transaction with active reimbursement links is blocked**, not cascaded — same for
  CSV import-batch undo, and (see below) for deleting an account that holds linked transactions.
  Enforced at both the DB level (`onDelete: Restrict`) and the service level (a clear error
  instead of a raw constraint failure).
- **Budgets net out reimbursements.** A category's "spent" total reflects `expense amount −
amount actually reimbursed`, clamped at 0 (overshoot is allowed but never becomes budget
  credit). Attributed to the **expense's month** — a January expense reimbursed in March
  retroactively lowers January's spent. Accepted: past months can shift when a late
  reimbursement arrives.
  **Superseded by `reimbursement-month-attribution.md`:** the default is now the month the
  money arrives; expense-month attribution is a per-user opt-in.
  An expense manually marked fully reimbursed counts as reimbursed for its full expected amount
  (linked total topped up to expected), since that's what "fully reimbursed" asserts.
- **The Overview page nets out reimbursements everywhere, not just budgets** — `hero.expense`,
  the category pie, daily bars, and Trends' expense sums all subtract reimbursed amounts too.
  This keeps the dashboard internally consistent: reimbursement income is already excluded from
  `hero.income`, so leaving `hero.expense` gross would make `hero.net` look worse than reality.
- **Link management lives on the expense's own transaction edit form**, not a separate page.
  `isReimbursable` / expected amount / the link panel are fields and a sub-panel on the existing
  transaction create/update flow (one `PATCH`, one round trip). Link CRUD (create/edit/delete a
  single link) is its own small resource, since links are managed one at a time from a picker
  without resubmitting the whole form.
- **The pending-reimbursement summary lives on the Accounts page, all-time (not month-scoped).**
  Every other Overview number is scoped to the selected month; an outstanding reimbursement from
  an earlier month would disappear from a month-scoped view while still unpaid, which isn't
  useful. Accounts already shows all-time state (balances), so it's the natural fit. Shows a
  total outstanding amount and a count.
- **Deleting an account with reimbursement-linked transactions is blocked too**, consistent with
  blocking transaction deletes. Links are cross-account by design (no requirement that the income
  and expense share an account), so deleting one account could otherwise silently orphan a link
  on another account's expense.

Assumptions made while designing, flagged rather than silently decided:

- **Mutual exclusion extends to the income side.** A reimbursable expense can't also be a
  transfer or a card payment (locked). Extended here: an income that's already `isTransfer` or
  `isPayment` can't be linked as a reimbursement either — those rows are already excluded from
  income aggregates for a different reason, and linking one would be semantically confused.
- **Un-marking `isReimbursable` while links exist is blocked**, read as equivalent to "reducing
  the expected amount below what's already linked." The alternative (auto-deleting the links)
  would silently destroy tracking history.
- **Manual links aren't date-constrained.** Suggestions only surface income dated on/after the
  expense, but a user can manually link an earlier income (reimbursement paid in advance is
  real).
- **One link row per (expense, income) pair.** A repeat contribution from the same income edits
  the existing link's amount rather than creating a duplicate row — enforced via upsert on a
  unique constraint, not an application check.
- **"Outstanding" on the income side is just the sum of that income's link rows** — there's no
  partial-settlement-of-a-link concept; a link has one amount.

## Schema — `prisma/schema.prisma`

**`Transaction`** gains three fields, no new enum (status is always derived, never stored):

```prisma
/// marks an EXPENSE the user expects to be paid back for. Mutually exclusive with
/// isTransfer/isPayment. Invariant: isReimbursable === true <=> reimbursementExpectedAmount !== null
isReimbursable              Boolean   @default(false)
/// how much of this expense is expected back; <= amount. equal = fully reimbursable,
/// less = partially. null when !isReimbursable
reimbursementExpectedAmount Decimal?  @db.Decimal(12, 2)
/// set only by the manual "mark fully reimbursed" override. A derived COMPLETE (linked
/// total >= expected) reverts to PARTIAL/PENDING if links shrink; a manual one only
/// reverts when the user explicitly un-marks it
reimbursementCompletedAt    DateTime?

reimbursementExpenseLinks ReimbursementLink[] @relation("ReimbursementExpense")
reimbursementIncomeLinks  ReimbursementLink[] @relation("ReimbursementIncome")

@@index([userId, isReimbursable])   // drives the all-time pending summary
```

**New model**, a real join table (not a soft correlation id, because it carries its own money):

```prisma
model ReimbursementLink {
  id                   String   @id @default(cuid())
  userId               String
  expenseTransactionId String
  incomeTransactionId  String
  amount               Decimal  @db.Decimal(12, 2)
  createdAt            DateTime @default(now())

  user    User        @relation(fields: [userId], references: [id], onDelete: Cascade)
  expense Transaction @relation("ReimbursementExpense", fields: [expenseTransactionId], references: [id], onDelete: Restrict)
  income  Transaction @relation("ReimbursementIncome",  fields: [incomeTransactionId],  references: [id], onDelete: Restrict)

  @@unique([expenseTransactionId, incomeTransactionId])
  @@index([userId])
  @@index([incomeTransactionId])
}
```

Plus `User.reimbursementLinks ReimbursementLink[]`. `userId` is denormalized onto the link (it's
derivable through either transaction) so services can scope reads directly — ownership is still
verified against both transactions at write time, the column isn't the trust boundary.

`onDelete: Restrict` on both transaction FKs makes "blocked, not cascaded" structurally
impossible to violate, backing up the service-level check. Three existing delete paths touch
`Transaction`: `transactions.ts` delete (gains an explicit guard anyway), `importBatches.ts` undo
(gains an explicit guard anyway), and `accounts.ts` delete (gains a new guard per the locked
decision above). `prisma/seed.ts`'s `transaction.deleteMany()` needs
`reimbursementLink.deleteMany()` added as the first line, or seeding fails under `Restrict`.

What the DB can't enforce (the service's job): expense row is `type === 'EXPENSE'` / income row is
`type === 'INCOME'`; a link's amount can't exceed the income's remaining unallocated amount; the
`isReimbursable ⇔ expectedAmount !== null` invariant.

Migration: **`add_reimbursable_expenses`**, purely additive (3 columns, 1 table, indexes, FKs, no
backfill). Note from `transfer-auto-matching.md`: the shared dev DB may already be drifted from an
unapplied hand-written migration — resolve that before running `npm run prisma:migrate`.

## `lib/services/reimbursements.ts` (new)

All `Decimal`/`Date` Prisma access for this feature lives here — `transactions.ts`, `budgets.ts`,
`overview.ts`, `trends.ts`, and `importBatches.ts` never learn the join table's shape.

**Types** (all plain strings/booleans, matching `FrontendTransaction`'s convention):
`ReimbursementStatus = 'PENDING' | 'PARTIAL' | 'COMPLETE'`, `FrontendReimbursementLink`,
`FrontendExpenseReimbursement` (status/totals/links for the edit-form panel),
`ReimbursementCandidate` (picker rows: `availableAmount`, `suggestedAmount`, `score`,
human-readable `reasons[]`), `FrontendReimbursementPendingSummary` (`pendingTotal`,
`pendingCount`).

**`deriveReimbursementStatus`** — pure, exported, unit-tested directly. In order: not reimbursable
→ `null`; `completedAt` set → `'COMPLETE'` (manual, sticky); linked ≥ expected → `'COMPLETE'`
(derived, reverts automatically); linked > 0 → `'PARTIAL'`; else `'PENDING'`.

**Reads**: `getExpenseReimbursement(userId, expenseTransactionId)` — the canonical return of every
link mutation, so the client always gets recomputed totals in one round trip.
`listReimbursementCandidates(userId, expenseTransactionId, { limit?, search? })` — the ranked
picker list. `getPendingReimbursementSummary(userId)` — two queries (reimbursable+incomplete
expenses, then a `groupBy` sum of their links), `outstanding = max(0, expected − linked)` per
expense, summed only where positive.

**Writes**: `createReimbursementLink` — loads both transactions scoped to `userId` in one query,
validates type/flag/self-link rules, checks the income's remaining capacity inside a
`$transaction`, then `upsert`s on the unique pair (repeat contributions edit the existing row).
`updateReimbursementLink` / `deleteReimbursementLink` — scoped `findFirst` then the same
capacity re-check / straight delete, both returning the recomputed expense summary. No
`setExpenseReimbursable` function — that write rides the existing `updateTransaction` (see below).

**Cross-service helpers**: `getLinkedCentsByExpense` / `getLinkedCentsByIncome` (cents keyed by
transaction id), `assertNoActiveLinks(userId, transactionIds, message)` (used by the delete
guards), `listReimbursedAmountsByExpenseDate(userId, start, end)` (the net-out source for
budgets/overview/trends — a relation-filtered query, not denormalized fields, so it can't drift
when an expense is recategorized or re-dated).

**Money**: `toCents(value) = Math.round(Number(value) * 100)`. Every comparison in the blocking
rules happens in integer cents, never `Decimal === Decimal` — the same trap `transfers.ts`
already documents.

**Suggestion ranking**: candidate pool is unlinked-to-this-expense INCOME rows, not transfer/
payment, dated on/after the expense, capped at 200. Score combines amount-closeness-to-outstanding
(60%), date-proximity (40%, decaying over ~45–120 days), and an optional payee-similarity bonus
reusing `categorize.ts`'s `compileRuleMatcher` rather than a second matcher. All weights/bands are
named constants at the top of the file — tuning, not a product requirement.

## Changed services

- **`transactions.ts`**: `FrontendTransaction` gains 8 fields (`isReimbursable`,
  `reimbursementExpectedAmount`, `reimbursementLinkedTotal`, `reimbursementOutstanding`,
  `reimbursementStatus`, `reimbursementCompletedManually`, `isReimbursementIncome`,
  `reimbursementIncomeLinkedTotal`). `toFrontend` sums the two new `include` selects and calls
  `deriveReimbursementStatus`, staying pure/synchronous. `updateTransaction` gains an ordered set
  of blocking rules (type change with active links, reimbursable+transfer/payment conflict,
  un-marking with links present, expected amount vs. expense amount vs. linked total, income
  amount vs. its linked total, marking complete without being reimbursable) via a new
  `ReimbursementConflictError extends ServiceValidationError` (409, not 404 — routes must check
  this subclass before the generic `ServiceValidationError` branch, since existing transaction
  routes map that to 404). `deleteTransaction` gains `assertNoActiveLinks`.
- **`budgets.ts`**: existing `groupBy` stays untouched; a third parallel query
  (`listReimbursedAmountsByExpenseDate`) reduces into spent, clamped at 0.
- **`overview.ts` / `trends.ts`**: income predicates gain `&& t._count.reimbursementIncomeLinks
=== 0`, mirroring the existing `isTransfer`/`isPayment` gates. Per the locked "net out
  everywhere" decision, `hero.expense`, `expenseBreakdown`, `dayBars`, `daySpent`, and Trends'
  expense/category sums also subtract reimbursed amounts (clamped per-transaction at 0). Account
  balances and `cycleSpend` stay gross — the money genuinely arrived/left, and a credit card
  statement shows the gross charge regardless.
- **`transfers.ts`**: `matchTransfers`'s candidate query excludes reimbursable expenses and any
  row with active links, so an auto-invoked post-import match can't silently flag a
  reimbursement-linked row as a transfer (found while designing — the mutual-exclusion rule
  otherwise has a hole).
- **`importBatches.ts`**: `undoImportBatch` checks for active links on any transaction in the
  batch, inside the same DB transaction as the delete, and blocks with a clear message.
- **`accounts.ts`**: `deleteAccount` gains the same `assertNoActiveLinks` guard. The pending
  summary read model is composed at the page level
  (`app/(protected)/accounts/page.tsx`), not inside `listAccounts` — keeps two unrelated read
  models from being coupled into one service function.

## Validators

- **`lib/validators/transactions.ts`**: three new fields (`isReimbursable`,
  `reimbursementExpectedAmount`, `reimbursementCompleted`) plus a shared cross-field
  `superRefine` (self-contained checks only — type/flag conflicts, expected ≤ amount when both are
  present in the payload). Everything that depends on existing DB state (current linked totals,
  the expense's amount on a partial `PATCH`) is enforced in the service, not Zod. The refinement
  must be layered so `updateTransactionSchema` stays fully partial — verify the exact Zod 4 API
  (`superRefine` vs. `check`) once installed.
- **`lib/validators/reimbursements.ts`** (new): create/update link schemas (`expenseTransactionId`,
  `incomeTransactionId`, `amount`), and a candidates query schema (`search`, `limit`).

## API routes

| Path                                                          | Method             | Purpose                                                      |
| ------------------------------------------------------------- | ------------------ | ------------------------------------------------------------ |
| `app/api/transactions/[id]/reimbursement/route.ts`            | `GET`              | Full reimbursement detail for one expense                    |
| `app/api/transactions/[id]/reimbursement/candidates/route.ts` | `GET`              | Ranked link-picker candidates, `?search=&limit=`             |
| `app/api/reimbursement-links/route.ts`                        | `POST`             | Create a link (201, returns recomputed expense summary)      |
| `app/api/reimbursement-links/[id]/route.ts`                   | `PATCH` / `DELETE` | Edit or remove a link (200 with recomputed summary, not 204) |

Marking reimbursable and the manual "fully reimbursed" override are **not** separate endpoints —
they ride the existing `PATCH /api/transactions/:id`, since the validation is cross-field against
the same row either way and a dedicated endpoint would mean two writes from one form. Existing
transaction routes gain a `ReimbursementConflictError` → 409 branch checked before the existing
`ServiceValidationError` branch.

## Frontend

No `Decimal`/`Date` leaks — every money field a `.toFixed(2)` string, every timestamp ISO, same as
today.

- `lib/transactions/transaction-payload.ts` / `use-transaction-form.ts`: reimbursable + expected
  amount state, with the same stale-checkbox guard the `isPayment` handling already uses.
- `components/transactions/transaction-form.tsx`: reimbursable checkbox + expected-amount input +
  the link panel (edit mode only — an unsaved transaction has no id to link against).
- New `components/transactions/reimbursement-panel.tsx` (links list, status, manual-complete
  toggle) and `reimbursement-link-picker.tsx` (search + ranked suggestions).
- `components/transactions/transactions-view.tsx`: a "Reimbursement income (excluded)" bucket in
  the summary reducer, alongside the existing Payments/Transfers chips.
- New `components/accounts/reimbursement-summary-card.tsx`, fed by a new prop on
  `AccountsView` from `app/(protected)/accounts/page.tsx`.

## Non-goals (this iteration)

- Cross-user/shared reimbursement tracking — no roles/tenant system exists.
- Marking INCOME as reimbursable, or tracking amounts owed with no originating expense.
- Notifications/reminders for long-pending reimbursements — the summary card is passive.
- CSV import support for reimbursement fields.
- CategoryRule interaction (auto-marking transactions reimbursable by payee).
- A dedicated "Reimbursements" list/report page — link management lives on the transaction form.
- Line-item granularity — the unit is always the whole transaction row.

## Checklist

- [ ] Resolve the unapplied `20260910120000_add_transfer_matching` migration / dev-DB drift
      before migrating (see `transfer-auto-matching.md`)
- [ ] `prisma/schema.prisma`: `isReimbursable`, `reimbursementExpectedAmount`,
      `reimbursementCompletedAt`, back-relations, `@@index([userId, isReimbursable])`
- [ ] `prisma/schema.prisma`: `ReimbursementLink` model (unique pair, 2 indexes,
      `onDelete: Restrict` both sides) + `User.reimbursementLinks`
- [ ] Migration `add_reimbursable_expenses` + `npm run prisma:generate`
- [ ] `prisma/seed.ts`: `reimbursementLink.deleteMany()` as the first destructive step
- [ ] `lib/services/common.ts`: `ReimbursementConflictError extends ServiceValidationError`
- [ ] `lib/validators/reimbursements.ts`: link + candidates schemas
- [ ] `lib/validators/transactions.ts`: add 3 fields + shared cross-field refinement, keep
      `updateTransactionSchema` fully partial
- [ ] `lib/services/reimbursements.ts`: types, `toCents`, `deriveReimbursementStatus`, reads,
      writes, cross-service helpers, suggestion ranking
- [ ] `lib/services/transactions.ts`: `FrontendTransaction` fields, `include`/`toFrontend`,
      create/update blocking rules, delete guard
- [ ] `lib/services/budgets.ts`: net out reimbursements from `spent`, clamped at 0
- [ ] `lib/services/overview.ts` + `trends.ts`: income gate + expense-side net-out everywhere
- [ ] `lib/services/transfers.ts`: exclude reimbursable/linked rows from `matchTransfers`
- [ ] `lib/services/importBatches.ts`: block undo when a batch transaction has links
- [ ] `lib/services/accounts.ts`: `deleteAccount` guard; pending summary composed at the page level
- [ ] Routes: reimbursement detail/candidates (GET), links (POST/PATCH/DELETE), 409 mapping
      ordered before the existing 404 mapping
- [ ] `app/(protected)/accounts/page.tsx`: fetch summary alongside `listAccounts`, pass to
      `AccountsView`
- [ ] UI: transaction form fields, reimbursement panel + picker, transactions-view summary
      bucket, accounts summary card
- [ ] Unit tests: `reimbursements.test.ts` (new), extend `transactions`, `budgets`, `overview`,
      `trends`, `transfers`, `importBatches`, `transaction-form` tests; add `reimbursementLink` to
      every affected hoisted `prismaMock`
- [ ] e2e: `tests/e2e/reimbursable-expenses.spec.ts`
- [ ] `npm run format:fix && npm run lint`, `npm run test`, `npm run test:e2e`,
      `npx tsc --noEmit`, `npm run build`
