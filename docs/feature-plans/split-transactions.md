# Split transactions

Status: requirement spec. Nothing here is built yet; every schema change below is a proposal that
needs the owner's approval before implementation.

## Problem

One bank row often covers several kinds of spending. A $240 Costco run is groceries, household
supplies and a gift; an Amazon order mixes electronics and books; a pharmacy receipt is part
health, part personal care. Today a transaction has exactly one `categoryId`, so the user either
picks the biggest category (and budgets drift) or enters fake manual transactions to fake a split
(and the account balance stops matching the bank).

## Users and stories

1. As a user, I split one transaction into two or more parts, each with its own category, amount
   and optional note, so each budget sees its real share.
2. As a user, the parts must add up to the transaction amount before I can save, and the form
   shows how much is left to assign.
3. As a user, the ledger still shows one row (matching my bank statement) with a "Split" badge,
   and I can expand it to see the parts.
4. As a user, I can remove a split and go back to a single category.
5. As a user, budgets, the dashboard, the expense pie, Trends and zero-based activity all count
   each part under its own category.
6. As a user, filtering transactions by a category shows split rows that have a part in that
   category, with the matching part's amount.

## Scope (v1)

- Splits apply to **expenses and income** that are not transfers or card payments.
- 2 to 20 parts per transaction. Each part has `categoryId` (nullable = uncategorized),
  `amount` (> 0, 2 decimals) and optional `note`.
- The sum of parts must equal the transaction amount exactly (in cents).
- The parent keeps `categoryId = null` while split; categories live on the parts.
- Splitting is done from the transaction form (desktop sheet and mobile overlay) via a
  "Split" action.
- Import: rows import unsplit; splitting happens afterwards.
- Categorize queue: a split transaction with any uncategorized part stays in the queue; the
  triage UI opens the split editor instead of the single category picker.

## Non-goals (v1)

- Splitting across accounts or dates (that's separate transactions).
- Percentage splits or saved split templates ("always split Costco 70/30").
- Splitting with other people / shared expenses (reimbursable expenses already cover the
  "someone owes me" case).
- Rules that produce splits automatically.

## Acceptance criteria

- Saving a split whose parts don't sum to the amount returns a 400 with "Parts must add up to
  $X (off by $Y)".
- Budgets: a $240 expense split $150 Groceries / $90 Household adds $150 to Groceries spend and
  $90 to Household spend for that month, and nothing to "uncategorized".
- The expense pie, day bars, Trends category breakdown and zero-based activity all use part
  amounts per category; totals per month are unchanged.
- Changing the parent amount while split is rejected unless the parts are updated in the same
  request.
- Marking a split transaction as a transfer or card payment is rejected until the split is
  removed. Same for spread and reimbursable in v1 (see open questions).
- Deleting the parent deletes its parts. Undoing an import deletes parts with their parents.
- A category delete sets the part's category to null (same as a transaction today).
- All reads and writes are scoped by `userId`; every part's `categoryId` is checked for
  ownership.
- Data export includes parts; data import restores them.

## Proposed design

### Schema (needs approval)

```prisma
model TransactionSplit {
  id            String   @id @default(cuid())
  userId        String
  transactionId String
  categoryId    String?
  amount        Decimal  @db.Decimal(12, 2)
  note          String?
  position      Int      /// display order
  // relations: user (Cascade), transaction (Cascade), category (SetNull)
  @@index([transactionId])
  @@index([userId, categoryId])
}
```

Plus `Transaction.isSplit Boolean @default(false)` so aggregate queries can branch without a
join.

### Aggregation rule

Every category aggregate today groups `Transaction` by `categoryId` (`budgets.ts`,
`overview.ts`, `trends.ts`, `zeroBased.ts`, `categorize.ts`, `transactionsPage.ts`). Each gets
one shared helper, `lib/services/categoryAmounts.ts`, that returns
`{ categoryId, amount }` rows from unsplit transactions plus split parts, filtered the same way
(date range, type, not transfer, not payment). Totals that don't care about category stay on
`Transaction`.

### Services / validators / API

- `lib/validators/transactions.ts`: optional `splits: [{ categoryId, amount, note }]` on create
  and update, with a refinement that the parts sum to `amount`.
- `lib/services/transactions.ts`: write parent + parts in one `$transaction`, set `isSplit`,
  null the parent `categoryId`, return parts on `FrontendTransaction` (`splits` array).
- `DELETE /api/transactions/[id]/splits` removes a split (parent gets the category the user
  picks, or null).

### UI

- Transaction form: "Split" button under the category field opens a part list with
  add/remove, a running "left to assign" amount and a disabled Save until it's zero.
- Ledger row: "Split" badge (reuses `transaction-badges.tsx`), expandable to show parts.
- Category filter shows the matching part amount next to the full amount.

## Interactions with existing features

- **Category rules:** still suggest one category for an unsplit row; ignored once split.
- **Spread expenses:** v1 blocks spread + split; a later version could spread each part.
- **Reimbursable expenses:** v1 blocks reimbursable + split.
- **Transfers / matchTransfers:** split rows are never matched.
- **AI categorization:** skips split rows.

## Open questions

1. Is it acceptable to block spread and reimbursable on split rows in v1?
2. Should parts allow a negative amount (a discount line) as long as the total matches?
3. Max parts: 20 enough?

## Checklist

- [ ] Owner approves scope, open questions and schema
- [ ] Architect pass: shared `categoryAmounts` helper and the list of aggregates to migrate
- [ ] UI spec: split editor (desktop + mobile), ledger badge and expand
- [ ] Test plan (unit per aggregate + service; e2e split, edit, unsplit, budget totals)
- [ ] Schema + migration
- [ ] Validator + service + routes + tests
- [ ] Migrate each aggregate to the helper, with parity tests
- [ ] UI
- [ ] Export/import support
- [ ] Tester review
