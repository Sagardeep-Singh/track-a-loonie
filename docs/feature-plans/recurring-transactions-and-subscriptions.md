# Recurring transactions and subscription detection

Status: requirement spec. Nothing here is built yet; every schema change below is a proposal that
needs the owner's approval before implementation.

## Problem

Most of a user's spending repeats: rent, phone, streaming, insurance, gym, a paycheque every two
weeks. Today the app only sees these after the fact, one row at a time. A user can't answer:

- "What bills are coming up before my next paycheque?"
- "Which subscriptions am I paying for, and what do they cost a year?"
- "Did my Netflix price just go up?"
- "Did my rent come out this month, or is it late?"

The data to answer this is already in the ledger (payee, amount, date, account), it's just never
grouped.

## Users and stories

1. As a user, I see a list of my recurring payments (bills, subscriptions, income) detected from
   my history, with how often each repeats, its typical amount and when it's next expected.
2. As a user, I confirm or dismiss a detected series so the list only holds what I agree with.
3. As a user, I add a recurring series by hand (for a new bill with no history yet).
4. As a user, I see the yearly cost of each subscription and the total across all of them.
5. As a user, I'm told when a confirmed series charges a different amount than usual (price
   change) or when an expected charge hasn't shown up a few days after its due date (missed).
6. As a user, I see the next 30 days of expected bills and income on the dashboard.

## Scope (v1)

- **Detection** runs over the user's own transactions: group by account + normalized payee +
  type, then keep groups with at least 3 occurrences whose gaps fit a cadence (weekly, biweekly,
  monthly, quarterly, yearly) within a tolerance, and whose amounts are stable (within 10% of the
  median, or exact for a fixed bill).
- **Series** are stored once confirmed or created by hand. Suggestions are computed on read and
  never stored until the user confirms them.
- **Matching:** each series links to the transactions that belong to it, so "last paid", "next
  expected" and "missed" come from real rows.
- **Recurring screen** (`/recurring`): Subscriptions, Bills and Income tabs. Each row shows payee,
  cadence, typical amount, next date, yearly cost and status chips (price change, missed).
- **Dashboard card:** "Coming up" with the next 30 days of expected charges and income.
- **Categorize integration:** a confirmed series can carry a category, and new matching
  transactions get it suggested the same way a rule does.

## Non-goals (v1)

- Creating transactions automatically on the due date (no "scheduled transactions" that write to
  the ledger). Expected rows are projections only.
- Cancelling subscriptions or contacting merchants.
- Push or email reminders for upcoming bills (can reuse the reminders cron later).
- Detection across accounts (the same bill paid from two different cards counts as two series).
- Variable-cadence bills ("every 28 days" or "the last business day of the month") beyond the
  tolerance window.

## Acceptance criteria

- With 3+ monthly charges from "NETFLIX.COM" on the same card at a stable amount, a suggestion
  appears with cadence Monthly, the median amount and a next date one cadence after the latest.
- Transfers, card payments and skipped rows never seed or match a series.
- Confirming a suggestion creates a series and links the transactions that formed it. Dismissing
  it hides that suggestion until a new transaction would materially change it (for example a
  new amount).
- A confirmed series whose newest match differs from the typical amount by more than 5% shows
  "Price changed from $X to $Y", and the typical amount moves to the new one once confirmed.
- A confirmed series with no match within `cadence tolerance` days after its expected date shows
  "Missed" until a match arrives or the user marks it paid or ended.
- Yearly cost = typical amount × occurrences per year (52, 26, 12, 4, 1). The Subscriptions tab
  total is the sum over active subscriptions.
- Everything is scoped by `userId`; a series can only link the owner's transactions.
- Deleting a transaction that's linked to a series removes the link and recomputes the series.

## Proposed design

### Schema (needs approval)

```prisma
enum RecurringCadence { WEEKLY BIWEEKLY MONTHLY QUARTERLY YEARLY }
enum RecurringKind { SUBSCRIPTION BILL INCOME }
enum RecurringStatus { ACTIVE ENDED }

model RecurringSeries {
  id            String           @id @default(cuid())
  userId        String
  accountId     String
  categoryId    String?
  kind          RecurringKind
  payeeKey      String           /// normalized payee used for matching
  displayName   String
  cadence       RecurringCadence
  typicalAmount Decimal          @db.Decimal(12, 2)
  anchorDate    DateTime         /// a known occurrence; next dates step from it
  status        RecurringStatus  @default(ACTIVE)
  createdAt     DateTime         @default(now())
  // relations: user, account (Cascade), category (SetNull)
  @@unique([userId, accountId, payeeKey])
}

model RecurringDismissal {
  id        String   @id @default(cuid())
  userId    String
  accountId String
  payeeKey  String
  signature String   /// cadence + rounded amount at dismissal time
  @@unique([userId, accountId, payeeKey])
}
```

Plus `Transaction.recurringSeriesId String?` (SetNull) and an index on it.

### Services

- `lib/recurring/detect.ts` (pure): `normalizePayee`, `detectCadence(dates)`,
  `detectSeries(rows)`. Unit-tested on its own, no Prisma.
- `lib/services/recurring.ts`: `listRecurring(userId)` (series + suggestions + status),
  `confirmSuggestion`, `createSeries`, `updateSeries`, `endSeries`, `dismissSuggestion`,
  `listUpcoming(userId, from, to)`. Detection reads a bounded window (last 15 months).
- `csvImport.commitImport` and `createTransaction` link new rows to a matching active series
  (best-effort, same as `matchTransfers`).

### Validators / API

- `lib/validators/recurring.ts`: create/update/confirm/dismiss schemas.
- `GET /api/recurring`, `POST /api/recurring`, `PATCH|DELETE /api/recurring/[id]`,
  `POST /api/recurring/suggestions/confirm`, `POST /api/recurring/suggestions/dismiss`,
  `GET /api/recurring/upcoming?from&to`.

### UI

- `/recurring` page with three tabs, an empty state that explains detection needs ~3 months of
  history, and a "Add recurring" sheet (reuses `ResponsiveDialog`, `MoneyInput`).
- Dashboard "Coming up" card (desktop column and mobile stack).
- Sidebar and bottom-nav entry.

## Interactions with existing features

- **Transfers / card payments:** excluded from detection and matching.
- **Spread expenses:** a spread transaction can still belong to a series (the annual insurance
  premium); the series uses the transaction amount, not the monthly share.
- **Cash-flow forecast** (separate spec) consumes `listUpcoming`.
- **Data export/import** (`lib/services/userData.ts`): series are exported by payee key and
  account name, not ids.
- **Account deletion:** cascades.

## Open questions

1. Should income series (paycheques) live here or only feed the forecast?
2. Tolerance per cadence: proposed ±3 days weekly/biweekly, ±5 monthly, ±10 quarterly, ±15
   yearly. OK?
3. Should a confirmed series auto-apply its category to new matches, or only suggest it in
   Categorize?

## Checklist

- [ ] Owner approves scope, open questions and schema
- [ ] Architect pass: final schema, detection algorithm, performance bounds
- [ ] UI spec for `/recurring` and the dashboard card
- [ ] Test plan (unit: detection and service; e2e: confirm, dismiss, price change, missed)
- [ ] Schema + migration
- [ ] Pure detection module + tests
- [ ] Service, validators, routes + tests
- [ ] UI
- [ ] Link on import and create
- [ ] Export/import support
- [ ] Tester review
