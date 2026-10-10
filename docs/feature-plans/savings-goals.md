# Savings goals

## Problem

Users save toward known amounts by a known date: a $3,000 trip next August, a $15,000 car down
payment in two years, a $1,200 insurance renewal. Today the app has no way to say "I need
$X by month Y" and get back "so put $Z away this month". Budget limits are spending caps (a
ceiling), and a savings goal is the opposite (a floor you want to reach). Zero-based mode
already lets a category grow a balance, but nothing tells the user how much to assign each
month to land on a target by a date.

## Scope

A savings goal is a target amount, a target month and a dedicated category. The app works out
how much is still needed, splits it across the remaining months, and shows "this month's
contribution" next to what was actually put aside. It works in both budgeting modes, with
progress measured the way each mode already thinks about money.

Non-goals for v1:

- Recurring goals that reset (for example "$1,200 every year for insurance"). A user can create
  a new goal when one finishes.
- Interest or investment growth projections.
- A goal with no date that derives the date from a fixed monthly amount ("save $200/month, when
  do I hit $5,000?"). Easy to add later on top of the same math.
- Several goals sharing one category, or one goal pulling from several categories.
- Push reminders for goals.

## Proposed decisions

These are recommendations. Items marked **(confirm)** need a call from the owner before the
architect step.

- **One goal per category, category required.** The goal reuses the category as its envelope
  in ZBB and as the tag for contributions in limits mode. The create form can create a new
  category inline ("Trip to Japan") or pick an existing one. `categoryId` is unique on the goal.
- **The monthly amount is recalculated every month, not fixed at creation.** The amount needed
  in month `m` is whatever is still missing at the start of `m`, split evenly over the months
  left (including `m`). Falling behind raises later months, getting ahead lowers them. This is
  the behavior people expect from YNAB-style "needed for spending by date" goals. **(confirm)**
- **Rounding reuses `allocateSpread` from `lib/spread.ts`.** This month's need is the first
  share of `allocateSpread(remainingCents, m, monthsLeft)`, so the extra cents go to the
  earliest months and the schedule always sums exactly to the remaining amount.
- **A goal has a `startingAmount`** for money already saved before the goal was created, so
  users don't have to back-fill transactions.
- **Past the target month and not reached:** the whole remainder is due in the current month and
  the goal shows as overdue. It is not auto-closed.
- **Reaching the target** marks the goal "funded" in the UI (derived, not stored). The user
  archives it manually once they've used the money. `archivedAt` hides it from both budget
  views.
- **A category can't have both a goal and a spending limit.** Mixing a cap and a floor on one
  category makes both numbers meaningless, and in ZBB both would compete to be the category's
  target. Creating a goal on a category that has a `Budget` row throws a
  `ServiceValidationError` that says to remove the limit first; creating a limit on a goal's
  category throws the mirror error. **(confirm, the alternative is "goal wins, limit ignored")**

## How progress and the monthly need work in each mode

Notation: `g` = goal, `c` = its category, `m` = YYYYMM month, `T` = target amount,
`S0` = `startingAmount`, `G` = goal `startMonth` (the month it was created),
`D` = `targetMonth`.

Common formulas, only `progressBefore` differs per mode:

```
monthsLeft(m)  = monthsBetween(m, D) + 1          // 1 in the target month itself
remaining(m)   = max(0, T - progressBefore(m))
need(m)        = m > D ? remaining(m)
               : allocateSpread(remaining(m), m, monthsLeft(m))[0].cents
schedule(m)    = allocateSpread(remaining(m), m, monthsLeft(m))   // shown as a preview
```

`progressBefore(m)` deliberately excludes month `m` itself, so this month's need doesn't shrink
as the user contributes. What they put aside this month is shown next to it as
`contributed(m)`.

### Limits mode (default)

Limits mode has no envelopes, so the only signal is real money moving. Progress is the net of
transactions in the goal's category since the goal started:

```
contributed(m)    = sum of EXPENSE in c dated in m  -  sum of INCOME in c dated in m
progressBefore(m) = S0 + sum of contributed(k) for G <= k < m
```

- The expected flow is "transfer $250 from chequing to savings, categorize it as Trip to
  Japan". The transfer flag is ignored on purpose: a matched transfer pair, a savings account
  that isn't imported (so the chequing leg is a plain EXPENSE), or a cash envelope all count.
- Pulling money back out is an INCOME in the goal category and lowers progress.
- **(confirm)** Spending the money (paying for the flights) should be categorized elsewhere,
  otherwise it would count as a contribution. Alternative: link the goal to an account and use
  the balance change since `G`. That is simpler for a dedicated account but breaks when one
  account holds several goals, so it's not the recommendation.
- Goal categories are excluded from limits-mode spend aggregates that would treat
  contributions as overspending. Today `listBudgets` only shows categories with a `Budget`
  row, and the "no limit and goal" rule above keeps goal categories out of it, so no change
  is needed there. The Overview expense pie and Trends do count non-transfer EXPENSE rows in
  the category as spending. **(confirm)** whether goal categories should be excluded from
  spending charts (recommended, otherwise saving looks like spending).
- UI: a "Savings goals" section under the limit cards on the Budgets page. Each goal shows a
  progress bar to `T`, "Save $Z this month", "Put aside $Y so far this month", months left and
  an on track / behind / funded / overdue badge.

### Zero-based mode

In ZBB the goal's category is the envelope, so the goal plugs into machinery that already
exists. Assigning money is the contribution:

```
contributed(m)    = assigned(c, m)
progressBefore(m) = S0 + available(c, m - 1) + offBudgetOut(c, < m)
```

- `available(c, m - 1)` is the existing `carriedIn`. It already rolls forward and already
  drops when the user spends from the category, which is correct: spending the trip money
  means it's no longer saved.
- `offBudgetOut(c, < m)` adds back categorized transfers from on-budget to off-budget accounts
  in `c` since `G`. ZBB counts those as category activity (the money leaves the budget), but
  for a goal it's still saved, just parked in the TFSA. Without this term, moving goal money
  to a savings account would look like losing progress.
- **`S0` in ZBB (confirm):** if the money already sits in the category's available, a non-zero
  `S0` double counts. Recommendation: in ZBB mode the create form hides `S0` and tells the
  user to assign the existing money to the category instead. `S0` only applies in limits
  mode, and on a switch from limits to ZBB the goal keeps its stored `S0` but ZBB ignores it.
  Alternative: keep `S0` in both modes and have the user not double fund.
- **Targets and "Assign to targets".** Today a ZBB target is the effective `Budget` limit and
  the top-up is `max(0, target - (carriedIn + assigned))`. A goal category instead gets
  `target = need(m)` with top-up `max(0, need(m) - assigned(c, m))`, because a goal is
  "assign this much every month", not "keep the balance at this level". `targetTopUps` in
  `lib/budgets/zero-based-math.ts` takes a per-category kind (`'limit' | 'goal'`) to pick the
  formula. The existing "not enough Ready to Assign" error covers both.
- **Overview insights.** `targetShortfall` and category health in
  `lib/budgets/zero-based-insights.ts` include goal categories (shortfall =
  `max(0, need(m) - assigned(c, m))`). Add a suggestion "Fund Trip to Japan: $250 left this
  month" ranked with the existing target suggestions.
- Future months: the ZBB view can already assign ahead. `need(m)` for a future month uses
  assignments before `m`, so pre-funding next month lowers next month's need automatically.

### Switching modes

Goals live in their own table and don't depend on the mode, so switching is non-destructive like
the rest of budgeting. Progress is recomputed with the active mode's formula. The numbers can
differ between modes for the same goal (limits counts transactions, ZBB counts assigned money);
the Settings mode switch should mention that goals are recalculated.

## Data model

Schema change required (this feature can't be built without it, needs explicit approval per
CLAUDE.md).

```prisma
/// a target amount to have saved in one category by a target month. The
/// monthly amount is derived on read (see lib/budgets/savings-goal-math.ts),
/// never stored, so falling behind or getting ahead just changes the next read.
model SavingsGoal {
  id             String    @id @default(cuid())
  userId         String
  /// one goal per category; the category is the ZBB envelope and the
  /// limits-mode contribution tag
  categoryId     String    @unique
  targetAmount   Decimal   @db.Decimal(12, 2)
  /// YYYYMM month the target should be reached by, inclusive
  targetMonth    Int
  /// YYYYMM month the goal was created; contributions count from here
  startMonth     Int
  /// money already saved before the goal existed; limits mode only
  startingAmount Decimal   @default(0) @db.Decimal(12, 2)
  /// hidden from budget views once set; the goal is kept for history/export
  archivedAt     DateTime?
  createdAt      DateTime  @default(now())
  updatedAt      DateTime  @updatedAt

  user     User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  category Category @relation(fields: [categoryId], references: [id], onDelete: Cascade)

  @@index([userId, archivedAt])
}
```

Name comes from the category, so there's no second name to keep in sync. Deleting the category
deletes the goal (cascade), matching how `Budget` and `CategoryAssignment` behave.

## Services and contracts

Pure math in `lib/budgets/savings-goal-math.ts` (integer cents, no Prisma), service in
`lib/services/savingsGoals.ts`.

```ts
export type GoalStatus = 'ON_TRACK' | 'BEHIND' | 'FUNDED' | 'OVERDUE' | 'NOT_STARTED';

export type FrontendSavingsGoal = {
  id: string;
  categoryId: string;
  categoryName: string;
  targetAmount: string;
  targetMonth: number;
  startMonth: number;
  startingAmount: string;
  /** progressBefore(month) + contributed(month) */
  saved: string;
  needThisMonth: string;
  contributedThisMonth: string;
  monthsLeft: number;
  status: GoalStatus;
  /** remaining months' planned amounts, for the schedule preview */
  schedule: { month: number; amount: string }[];
  archivedAt: string | null;
};

// math
computeGoalMonth(args: { targetCents; targetMonth; startMonth; month; progressBeforeCents;
  contributedCents }): { needCents; monthsLeft; status; schedule }

// service
listSavingsGoals(userId, month, opts?: { includeArchived?: boolean }): Promise<FrontendSavingsGoal[]>
createSavingsGoal(userId, input): Promise<FrontendSavingsGoal>   // input may carry newCategoryName
updateSavingsGoal(userId, goalId, input): Promise<void>
archiveSavingsGoal(userId, goalId, archived: boolean): Promise<void>
deleteSavingsGoal(userId, goalId): Promise<void>
getGoalNeedsForMonth(userId, month): Promise<Map<string, number>> // categoryId -> need cents, for ZBB
```

Status: `NOT_STARTED` when `month < startMonth`, `FUNDED` when saved >= target, `OVERDUE` when
`month > targetMonth`, `BEHIND` when `contributedThisMonth < needThisMonth` and it's the last
month or the need has grown from the even split at creation, otherwise `ON_TRACK`. **(confirm
the exact "behind" rule with ui-designer, the simple alternative is "this month not yet
funded")**.

Validation (`ServiceValidationError`):

- Category belongs to the user, has no goal yet, has no `Budget` limit (see decisions).
- `targetAmount > 0`, `startingAmount >= 0` and `< targetAmount`.
- `targetMonth >= current month` on create, at most 10 years out.
- `updateSavingsGoal` can change amount, target month and starting amount; not the category.

Existing services touched:

- `budgets.ts`: `createBudget` rejects a category that has a goal.
- `zeroBased.ts`: `getZbbMonth` merges goal needs into `target`, adds `targetKind` and
  `goalId` to `FrontendZbbCategory`; `assignToTargets` passes the kind to `targetTopUps`.
  Off-budget transfer totals per category come from the same transfer-counterpart lookup
  `categoryActivity` already does.
- `zero-based-insights.ts`: goal shortfall and suggestion.
- `overview.ts` / `trends.ts`: only if the "exclude goal categories from spending" question is
  answered yes.
- `userData.ts`: export/import `SavingsGoal`, bump `USER_DATA_FORMAT_VERSION` to 3, keep
  accepting version 1 and 2 files.
- `accountDeletion.ts`: covered by the user cascade, verify only.

## Validators and routes

- `lib/validators/savings-goals.ts`: `createSavingsGoalSchema` (either `categoryId` or
  `newCategoryName`, amounts as 2-decimal strings like the budget validators, months as
  YYYYMM ints), `updateSavingsGoalSchema`, `archiveSavingsGoalSchema`.
- `app/api/savings-goals/route.ts`: `GET ?month=` list, `POST` create.
- `app/api/savings-goals/[id]/route.ts`: `PATCH` update or archive, `DELETE`.
- Handlers stay thin: session, Zod parse, service call, map `ServiceValidationError` to 400.

## UI (for ui-designer to spec)

- Budgets page, both modes: a "Savings goals" section with goal cards and an "Add goal" button.
  Reuse the card and ring patterns from `components/budgets/budget-ring.tsx`.
- Goal dialog: category picker with "create new", target amount, target month picker, starting
  amount (limits mode only), and a live preview "Save $250/month for 12 months".
- Goal card: progress bar, saved / target, this month's need vs contributed, months left,
  status badge, schedule disclosure (next N months), edit / archive / delete menu.
- ZBB view: goal categories show a goal icon and "$250 needed this month" in the target column;
  "Assign to targets" includes them.
- Empty state on the section explaining goals in one line.

## Test plan outline (tester to expand)

Unit (`tests/unit/...`):

- `savings-goal-math`: even split, remainder cents to earliest months, catching up after a
  missed month, getting ahead, funded, target month itself, overdue, not started, zero
  remaining.
- `savingsGoals` service: limits-mode progress (expense adds, income subtracts, transfer flag
  ignored, only since start month), ZBB progress (carriedIn + off-budget transfers, spending
  lowers it, `S0` ignored), ownership checks, goal and limit mutual exclusion, archive hides.
- `zeroBased`: `assignToTargets` funds goal need with the goal formula and limits with the
  existing one, shortfall error includes both.
- `userData`: round trip with goals, v2 file import still works.

E2E (`tests/e2e/savings-goals.spec.ts`):

- Create a goal with a new category in limits mode, see the monthly amount, add a contribution
  transaction, see progress move.
- Same in ZBB: assign to the goal category, "Assign to targets" funds it.
- Validation errors (past target month, category with a limit).
- Archive and delete.

## Implementation checklist

- [ ] Owner confirms the **(confirm)** items above
- [ ] Owner approves the schema change
- [ ] software-architect review of contracts and the ZBB `targetTopUps` change
- [ ] ui-designer spec for the goals section, dialog and ZBB markers
- [ ] tester writes unit and e2e test plans
- [ ] Prisma model + migration, `npm run prisma:generate`
- [ ] `lib/budgets/savings-goal-math.ts` + unit tests
- [ ] `lib/validators/savings-goals.ts` + unit tests
- [ ] `lib/services/savingsGoals.ts` + unit tests
- [ ] `budgets.ts` mutual exclusion check
- [ ] ZBB integration (`zeroBased.ts`, `zero-based-math.ts`, `zero-based-insights.ts`)
- [ ] API routes
- [ ] UI: goals section, dialog, ZBB markers
- [ ] Data export/import v3
- [ ] E2E specs
- [ ] `npm run format:fix && npm run lint`, `npm run test`, `npm run test:e2e`
