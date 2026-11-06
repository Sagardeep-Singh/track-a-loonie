# Balance-Tracked Accounts and Balance History

## Goal

Savings, registered (TFSA, RRSP, ...) and investment accounts change value through growth, interest and contributions that the user doesn't want to log as transactions. Let these accounts be tracked by logging an updated balance from time to time, and give every account (transaction-based or balance-tracked) a balance-over-time chart, plus a net worth over time chart across all accounts.

## Decisions (confirmed with the user)

- **Per-account toggle**, "Track by balance updates" (`Account.tracksBalance`). New accounts default it on for Savings, Registered and Investment types, off for the rest. The user can change it.
- **No transactions on balance-tracked accounts.** Creating, moving or importing a transaction into one is rejected server-side, and those accounts are left out of the transaction and import account pickers.
- **Charts live on a new account detail page** (`/accounts/[id]`) with balance over time, change over the range and the balance update log. The Accounts page gets a net worth over time chart.

## Assumptions (not explicitly decided, flagged here)

- **Balance of a tracked account** is the most recent balance update by date (ties: latest created). Creating a tracked account, or turning tracking on for an account with no updates yet, logs its starting balance as the first update dated today (UTC), so the chart starts from it. With no updates at all, the balance falls back to `startingBalance`.
- **Turning tracking on** is refused while the account has transactions (the user moves or deletes them first). **Turning it off** copies the current tracked balance into `startingBalance` so the displayed balance doesn't jump; existing updates are kept (ignored while untracked, back if re-enabled).
- **Tracked accounts are always off-budget.** Ready to Assign is computed from starting balance plus transactions, and a tracked balance moves without transactions, so it can't feed it. The service forces `onBudget: false` and the form hides the toggle.
- **Updates can be backdated** (to record history) but not dated in the future (one day of slack for timezones). Updates can be added and deleted, not edited (delete and re-log).
- **Monthly granularity for charts**: each point is the balance at the end of a month (the current month shows the latest balance). Ranges 6, 12 or 24 months, default 12. Months before an account has any data are empty for that account and count as 0 toward net worth.
- **Transaction-account history** is derived: `startingBalance` plus every signed transaction dated before the month's end. Its first month is the earlier of the account's creation month and its first transaction's month.
- **Data export/import** carries `tracksBalance` and the balance updates (format version 4; v1-v3 files still import with tracking off).

## Non-goals

- Editing a balance update in place.
- Contribution vs. growth split, contribution room, rates of return.
- Daily or per-update chart granularity.
- Counting tracked accounts toward Ready to Assign.

## Data model change

- `Account.tracksBalance Boolean @default(false)` - existing accounts keep today's behaviour, no backfill.
- New `AccountBalanceUpdate { id, userId, accountId, balance Decimal(12,2), date DateTime, note String?, createdAt }`, cascade on account and user delete, `@@index([accountId, date])`, `@@index([userId])`.

## Contracts

- `lib/account-types.ts`: `defaultTracksBalanceFor(type)` (Banking savings, Registered, Investment -> true).
- `lib/account-history.ts` (pure): `historyMonths(endMonth, range)`, `transactionAccountMonthlyBalances(...)`, `trackedAccountMonthlyBalances(...)`, `latestBalanceUpdate(...)`, `balanceChange(points)`.
- `lib/services/accounts.ts`: `FrontendAccount` gains `tracksBalance` and `balanceUpdatedAt`. `createAccount`/`updateAccount` apply the toggle rules above.
- `lib/services/accountBalances.ts`: `createBalanceUpdate`, `deleteBalanceUpdate`, `getAccountHistory(userId, accountId, range)`, `getNetWorthHistory(userId, range)`.
- `lib/validators/accounts.ts`: `tracksBalance` on create/update, `createBalanceUpdateSchema { balance, date, note? }`.
- Routes: `POST /api/accounts/[id]/balance-updates`, `DELETE /api/accounts/[id]/balance-updates/[updateId]`.
- Transactions: `assertOwnedRefs` (create + move) and `commitImport` reject tracked accounts.

## Implementation checklist

- [x] Schema: `tracksBalance` + `AccountBalanceUpdate`, hand-written migration, `npm run prisma:generate`
- [x] `lib/account-types.ts`: `defaultTracksBalanceFor`
- [x] `lib/account-history.ts`: pure month/balance math
- [x] `lib/validators/accounts.ts`: `tracksBalance`, `createBalanceUpdateSchema`
- [x] `lib/services/accounts.ts`: frontend shape, create/update toggle rules
- [x] `lib/services/accountBalances.ts`: update CRUD + history + net worth
- [x] `lib/services/transactions.ts`, `lib/services/csvImport.ts`: reject tracked accounts
- [x] `lib/services/userData.ts` + `lib/validators/user-data.ts`: round-trip `tracksBalance` and updates (format v4)
- [x] API routes for balance updates; PATCH account returns 400 with the message for rule violations
- [x] `components/accounts/balance-line-chart.tsx`, `history-range-pills.tsx`, `account-detail-view.tsx`, `balance-update-form.tsx`
- [x] `app/(protected)/accounts/[id]/page.tsx` detail page
- [x] Accounts page: net worth chart, card links to detail, "Log balance" on tracked cards, form toggle
- [x] Filter tracked accounts out of transaction / import / budgeting pickers
- [x] Unit tests: `tests/unit/lib/account-history.test.ts`, `tests/unit/services/accountBalances.test.ts`, additions to `accounts.test.ts`, `transactions.test.ts`, `csvImport.test.ts`, validators
- [x] E2E: `tests/e2e/balance-tracked-accounts.spec.ts`
- [x] `npm run format:fix && npm run lint`, `npm run test`, `npm run test:e2e`

## Implementation notes

- Each entry in the balance update log shows its change from the update before it. Month-end chart points alone hide that when two updates fall in the same month.
- `balanceChange` returns null with fewer than two months of data, so a brand-new account doesn't show "+$0.00 over the last 12 months".
- Tracked accounts are filtered out at the page level before reaching the add-transaction overlay, the Transactions view, the Import view and Settings' budgeting picker. The services enforce the rule regardless.
- `PATCH /api/accounts/[id]` now answers 400 (not 404) with the message when an edit breaks a rule, so the account form can show why.
- Migration hand-written and checked with `prisma migrate deploy` plus `prisma migrate diff` (no drift) on a local Postgres 16.

## Test plan

### Unit (`tests/unit/...`)

- `lib/account-history.test.ts`
  - `historyMonths` returns `range` consecutive months ending at the end month, across a year boundary.
  - Transaction account: month-end balance = starting + signed transactions dated before next month; months before first activity are null; transactions before `createdAt` still count.
  - Tracked account: month-end balance = latest update on or before month end; null before the first update; ties on date pick the latest `createdAt`.
  - `balanceChange`: first non-null to last, percent null when the start is 0, null with fewer than two months of data.
- `services/accountBalances.test.ts`
  - `createBalanceUpdate` rejects unknown/foreign accounts, rejects untracked accounts, stores the balance and date.
  - `deleteBalanceUpdate` only deletes the user's own update on that account.
  - `getAccountHistory` 404s on a foreign account, returns monthly points and change for both account kinds.
  - `getNetWorthHistory` sums accounts per month, treating empty months as 0.
- `services/accounts.test.ts`
  - Tracked accounts report the latest update as balance and `transactionCount` 0.
  - Create defaults `tracksBalance` by type, forces `onBudget` off, logs the starting balance as the first update.
  - Update: turning tracking on with transactions is refused; turning it on without logs the first update; turning it off copies the tracked balance into `startingBalance`; `onBudget: true` on a tracked account is refused.
- `services/transactions.test.ts` / `services/csvImport.test.ts`: tracked account rejected for create, move and import.
- `validators`: balance update schema rejects missing/non-numeric balance, bad dates, future dates, long notes.

### E2E (`tests/e2e/balance-tracked-accounts.spec.ts`)

- Create a TFSA: tracking is on by default, card shows "Updated" date and a "Log balance" action.
- Log a new balance from the detail page: balance and change update, the entry shows in the log, deleting it reverts the balance.
- The TFSA is not offered in the add-transaction account picker.
- A checking account's detail page shows a balance chart from its transactions.
- Accounts page shows the net worth chart.
