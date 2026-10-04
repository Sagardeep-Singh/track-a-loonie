# Zero-based budgeting (opt-in mode)

## Problem

Budgets today are spending caps. A `Budget` row is `categoryId + month + limitAmount`, it repeats
into later months until changed, and each card compares spending against the limit. Nothing ties
the budget to real money: you can budget $10k a month with $2k in the bank, unspent money
disappears at month end, income plays no part, and irregular bills (annual insurance, gifts)
blow up the month they land in.

Zero-based budgeting (ZBB) answers a different question: "what is each dollar I own for?" Every
dollar in on-budget accounts gets assigned to a category until **Ready to Assign** hits zero.
Leftovers roll over, overspending has to be covered from another category, and savings goals
are just categories with a growing balance.

## Scope

An opt-in, per-user budgeting mode that sits alongside the current spending-limit mode. Users who
never turn it on see no change. Switching modes is non-destructive: limits and ZBB data are both
kept, and the Budgets page renders whichever mode is active.

## Decisions

Locked during product discussion (not open for the implementer to revisit):

- **Opt-in per user, toggled in Settings.** The Budgets page shows either the limits view or the
  ZBB view. Both data sets are preserved when switching.
- **Assign money only after it exists.** Ready to Assign is derived from real on-budget account
  balances. There is no "expected income" field. Income of any amount, on any schedule (weekly,
  biweekly, irregular), raises Ready to Assign when the transaction lands.
- **Ready to Assign is global, not per month.** Assigning to a future month is allowed and
  reduces Ready to Assign now. This is how "living one month ahead" works without a special
  holding category.
- **Accounts are on-budget or off-budget.** New `Account.onBudget` flag. Defaults: CHECKING, CASH
  and CREDIT_CARD on, SAVINGS off. Users can change it per account. Off-budget accounts still
  count toward balances and net worth everywhere else in the app.
- **Credit cards: simple on-budget (option 1).** A card is an on-budget account with a negative
  balance. A purchase on the card is category activity just like debit. Paying the card from
  chequing is a transfer between two on-budget accounts and doesn't touch the budget. Existing
  card debt at enable time lowers the starting Ready to Assign. No auto-managed payment
  categories. The YNAB-style payment category can be layered on later, since it can be derived
  from existing transactions.
- **Overspending carries forward as a negative.** A category that ends the month below zero
  starts next month in the red until the user covers it. Nothing is silently taken from Ready to
  Assign.
- **Transfers from on-budget to off-budget accounts count as category activity.** The on-budget
  leg uses its category (for example "Savings"). If it has no category, it reduces Ready to
  Assign. Transfers between two on-budget accounts (including card payments) are ignored.
  Transfers from off-budget into on-budget raise Ready to Assign like any other inflow.
- **Income goes to Ready to Assign regardless of its category.** Same treatment as today, where
  budget spend only counts EXPENSE rows. Exception: reimbursement netting keeps its existing
  behavior (see Math), so a paid-back expense returns money to the expense's category.
- **Existing budget limits become ZBB targets.** No duplicate concept. An "Assign to targets"
  action tops each category up to its effective limit.
- **ZBB starts at a start month.** Set to the current month the first time the user enables ZBB.
  Everything before it is baked into the starting Ready to Assign through account balances.

## Math

Notation: `c` = category, `m` = YYYYMM month, `S` = the user's `zbbStartMonth`.

- **assigned(c, m)**: the `CategoryAssignment.amount` for that cell, default 0. May be negative
  (money moved out of a category that was funded in an earlier month).
- **activity(c, m)**: for months `m >= S`, the sum of EXPENSE transactions in category `c` dated
  in `m` on **on-budget** accounts, where the row is either not a transfer, or is a transfer
  whose counterpart leg (same `transferMatchId`) is on an **off-budget** account. Minus
  reimbursed amounts attributed to the expense's month, using
  `listReimbursedAmountsByExpenseDate` the same way `listBudgets` does, limited to expenses on
  on-budget accounts.
- **available(c, m)** = `available(c, m - 1) + assigned(c, m) - activity(c, m)`, with
  `available(c, S - 1) = 0`. Negative values carry forward.
- **Ready to Assign** = `sum(on-budget account balances, all time)`
  `- sum over c of (sum of assigned(c, m) for all m >= S - sum of activity(c, m) for all m >= S)`.

Invariant: `sum(on-budget balances) = Ready to Assign + sum over c of available(c, latest)`.

Behaviors that fall out of the formula without special cases:

- Income on an on-budget account raises the balance and nothing else, so Ready to Assign goes up.
- Uncategorized on-budget expenses lower the balance with no category activity, so they reduce
  Ready to Assign. The UI should flag this.
- Deleting a category cascades its assignments, and its transactions become uncategorized. The
  net effect returns its available money to Ready to Assign.
- A late reimbursement raises the balance and reduces the expense category's activity by the
  same amount, so the money lands back in the category and Ready to Assign is unchanged.

The 3-month example from the planning discussion ($20,000 starting chequing, $5,000 monthly
income, groceries overspend covered from Fun, $1,200 car insurance sinking fund, $300 unplanned
medical covered from the emergency fund) should be encoded as a unit test fixture. The expected
end-of-March chequing balance is $23,810, equal to the sum of category availables, with Ready to
Assign at $0.

## Data model

Schema changes are required by this feature (explicitly authorized by the task).

```prisma
enum BudgetMode {
  LIMITS
  ZERO_BASED
}

/// per-user budgeting mode. Absence of a row means LIMITS, which is the
/// default for every existing and new user, so no backfill is needed.
model UserBudgetSettings {
  id            String     @id @default(cuid())
  userId        String     @unique
  mode          BudgetMode @default(LIMITS)
  /// YYYYMM month ZBB math starts from; set the first time ZBB is enabled
  /// and kept when switching back to LIMITS so re-enabling resumes
  zbbStartMonth Int?
  createdAt     DateTime   @default(now())
  updatedAt     DateTime   @updatedAt

  user User @relation(fields: [userId], references: [id], onDelete: Cascade)
}

/// money assigned to a category for one month in ZBB mode. Unlike Budget,
/// it does not repeat into later months; leftovers carry through
/// `available`, not through this row.
model CategoryAssignment {
  id         String   @id @default(cuid())
  userId     String
  categoryId String
  month      Int
  amount     Decimal  @db.Decimal(12, 2)
  createdAt  DateTime @default(now())
  updatedAt  DateTime @updatedAt

  user     User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  category Category @relation(fields: [categoryId], references: [id], onDelete: Cascade)

  @@unique([userId, categoryId, month])
  @@index([userId, month])
}
```

`Account` gets `onBudget Boolean @default(true)`. The migration sets `onBudget = false` for
existing SAVINGS accounts. `createAccount` sets it from type when the input omits it.

## Services and contracts

New `lib/services/zeroBased.ts`, with pure math in `lib/budgets/zero-based-math.ts` so it can be
unit-tested without a database.

```ts
export type FrontendZbbCategory = {
  categoryId: string;
  categoryName: string;
  carriedIn: string; // available(c, m - 1)
  assigned: string;
  activity: string;
  available: string;
  target: string | null; // effective Budget limit for this month, if any
};

export type FrontendZbbMonth = {
  month: number;
  startMonth: number;
  readyToAssign: string;
  uncategorizedOnBudget: { count: number; total: string };
  categories: FrontendZbbCategory[];
};

getBudgetSettings(userId): Promise<{ mode: 'LIMITS' | 'ZERO_BASED'; zbbStartMonth: number | null }>
setBudgetMode(userId, input: { mode }): Promise<...> // sets zbbStartMonth on first enable
getZbbMonth(userId, month): Promise<FrontendZbbMonth>
setAssignment(userId, input: { categoryId; month; amount }): Promise<FrontendZbbMonth>
moveMoney(userId, input: { fromCategoryId; toCategoryId; month; amount }): Promise<FrontendZbbMonth>
assignToTargets(userId, month): Promise<FrontendZbbMonth>
```

Rules enforced in the service (throw `ServiceValidationError`):

- All writes require mode `ZERO_BASED`.
- `month >= zbbStartMonth` and no more than 12 months past the current month.
- Category must belong to the user. `fromCategoryId !== toCategoryId`. Move `amount > 0`.
- `setAssignment` sets the absolute assigned amount for the cell (upsert); a 0 amount deletes the
  row. Ready to Assign may go negative (shown as an error state in the UI, not blocked), so the
  user can fix it by un-assigning.
- `moveMoney` adjusts both cells in one `prisma.$transaction`.
- `assignToTargets`: for each category with a target, the top-up is
  `max(0, target - (carriedIn + assigned))`. If the total top-up exceeds Ready to Assign, nothing
  is written and the service throws with the shortfall, so the UI can explain it.
- Activity aggregation uses one `$queryRaw` grouped by category and YYYYMM, scoped by `userId`
  and the user's on-budget account ids, with a self-join on `transferMatchId` to apply the
  transfer rule. Bounded to `date >= start of zbbStartMonth`.

Existing services touched:

- `accounts.ts`: expose `onBudget` on `FrontendAccount`, accept it in create/update.
- `overview.ts`: in ZBB mode, budget rings use `carriedIn + assigned` as the limit and `activity`
  as spent (see open questions).
- `userData.ts`: export/import `UserBudgetSettings`, `CategoryAssignment` and `Account.onBudget`.
  Bump `USER_DATA_FORMAT_VERSION` to 2 and keep accepting version 1 files (missing fields take
  defaults).

## Validators and routes

- `lib/validators/zero-based.ts`: `budgetModeSchema`, `setAssignmentSchema` (amount allows
  negative, two decimals), `moveMoneySchema`, `assignToTargetsSchema`.
- `lib/validators/accounts.ts`: optional `onBudget` boolean on create and update.
- Routes (thin handlers: validate, call service, return):
  - `PATCH /api/settings/budget-mode`
  - `PUT /api/budgets/assignments`
  - `POST /api/budgets/assignments/move`
  - `POST /api/budgets/assignments/targets`

The Budgets page is a server component, so reads go straight through `getZbbMonth`.

## UI

- **Settings, "Budgeting style" section**: radio for Spending limits or Zero-based. Enabling
  shows a short explainer and the account list with on-budget toggles, then confirms. The copy
  states that switching back keeps all data.
- **Accounts**: "Off-budget" badge on off-budget accounts and an on-budget toggle in the edit
  form. Only shown when ZBB is enabled.
- **Budgets page in ZBB mode** (`components/budgets/zero-based-view.tsx`):
  - Ready to Assign banner at the top: positive means "assign it", zero is the goal state,
    negative is an error ("You've assigned more than you have").
  - Category table: carried in, assigned (inline editable), activity, available. Negative
    available rows are highlighted with a "Cover" action.
  - Move money dialog (from category, to category, amount). Also reachable from "Cover".
  - "Assign to targets" button when any category has a target.
  - Notice when uncategorized on-budget transactions are reducing Ready to Assign, linking to
    the categorize screen.
  - Month picker allows future months. Months before the start month show an empty state.
  - Mobile: the table collapses to cards with the same fields.
- Header description changes per mode.

## Non-goals

- YNAB-style credit card payment categories.
- Goal types beyond "top up to the existing limit" (target dates, monthly savings goals).
- Auto-assign by priority, and splitting a paycheque automatically.
- Changing the start month or resetting ZBB after enabling.
- Expected or scheduled income.
- Any change to how transactions, imports, transfers or reimbursements are recorded.

## Open questions

Defaults below are what the implementation uses unless the owner says otherwise.

1. **Dashboard budget rings in ZBB mode.** Default: show `carriedIn + assigned` vs `activity`.
   Alternative: hide the rings in ZBB mode.
2. **Refunds recorded as INCOME with a spending category** go to Ready to Assign, not back to the
   category. The user can move them by hand. Revisit if it proves annoying.
3. **Uncategorized on-budget expenses** reduce Ready to Assign silently apart from the notice.
   An alternative is a pseudo "Uncategorized" row in the table.

## Test plan (acceptance bar)

Unit (`tests/unit/...`):

- `lib/budgets/zero-based-math`: available carry-forward, negative carry, Ready to Assign
  formula, the 3-month worked example end to end.
- `services/zeroBased`: mode gating; first enable sets start month, re-enable keeps it; assign
  set, update and zero-delete; move money is atomic and validates; assign to targets with enough
  and with too little Ready to Assign; months before start or too far ahead rejected; another
  user's category rejected.
- Activity rules: off-budget account expenses ignored; on-budget to on-budget transfer ignored;
  on-budget to off-budget transfer counted in its category; uncategorized expense reduces Ready
  to Assign; card purchase counts as activity and card payment doesn't; reimbursement returns
  money to the category.
- `services/accounts`: `onBudget` defaults by type and can be updated.
- `services/userData`: v2 round trip; v1 import still works with defaults.
- Validators: amount bounds and decimals, negative assignment allowed, move amount must be
  positive.

E2E (`tests/e2e/zero-based-budgeting.spec.ts`, Playwright):

- Enable ZBB in Settings, see Ready to Assign equal to on-budget balances.
- Assign to categories until Ready to Assign shows $0.
- Add an expense that overspends a category, see the negative row, cover it via move money.
- Switch back to Spending limits and confirm the limits view and data are unchanged.
- Error states: over-assigning shows the negative banner; assign to targets with insufficient
  funds shows the shortfall.

## Checklist

- [ ] Schema: `BudgetMode`, `UserBudgetSettings`, `CategoryAssignment`, `Account.onBudget`;
      migration with SAVINGS backfill; `npm run prisma:generate`.
- [ ] Pure math module with unit tests, including the 3-month example.
- [ ] `zeroBased.ts` service: settings, month read, activity query, assign, move, targets.
- [ ] Service unit tests per the test plan.
- [ ] Validators and route handlers.
- [ ] Accounts: `onBudget` in service, validator, form and badge.
- [ ] Settings: Budgeting style section with enable flow.
- [ ] Budgets page: mode switch, `ZeroBasedView`, move money dialog, targets, notices, mobile.
- [ ] Overview: budget rings in ZBB mode.
- [ ] Data export/import v2 with v1 compatibility.
- [ ] E2E spec.
- [ ] `npm run format:fix && npm run lint`, `npm run test`, `npm run test:e2e`.
