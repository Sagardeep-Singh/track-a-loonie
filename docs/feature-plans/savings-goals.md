# Savings goals

## Problem

Users save toward known amounts by a known date: a $3,000 trip next August, a $15,000 car down
payment in two years, a $1,200 insurance renewal. Today the app has no way to say "I need $X by
month Y" and get back "so put $Z away this month". Budget limits are spending caps (a ceiling),
and a savings goal is the opposite (a floor you want to reach). Zero-based mode already lets a
category grow a balance, but nothing tells the user how much to assign each month to land on a
target by a date.

## Scope

A savings goal is a target amount, a target month and a dedicated category. The app works out
how much is still needed, splits it across the remaining months, and shows "this month's
contribution" next to what was actually put aside. It works in both budgeting modes.

Money put toward a goal counts as used in the month it's saved. When the goal money is later
spent, that spending is covered by the goal and doesn't count as an expense a second time.

Non-goals for v1:

- Recurring goals that reset (for example "$1,200 every year for insurance"). A user can create
  a new goal when one finishes.
- Interest or investment growth projections.
- A goal with no date that derives the date from a fixed monthly amount.
- Several goals sharing one category, or one goal pulling from several categories.
- Push reminders for goals.
- A "saved" series in Trends.

## Decisions

Locked with the owner:

- **The monthly target is recalculated every month from previous months' contributions.** The
  amount needed in month `m` is whatever is still missing at the start of `m`, split evenly
  over the months left (including `m`). Falling behind raises later months, getting ahead
  lowers them. Nothing about the schedule is stored.
- **A category can't have both a goal and a spending limit.** Creating a goal on a category
  that has a `Budget` row throws a `ServiceValidationError` that says to remove the limit
  first; creating a limit on a goal's category throws the mirror error.
- **Contributions count as used in the month they're saved, and spending the goal money later
  doesn't count again.** Contributions show as their own "Saved" figure on the Overview, and
  `net = income - expense - saved`. Spending in a goal category is covered by the goal up to
  what's been saved and is left out of that month's expenses, the expense pie, day bars and
  Trends. Spending beyond what was saved counts as a normal expense.
- **Behind** means the contributions in previous months didn't meet the plan, so this month's
  amount had to be raised to finish on time (see Status).
- **Contributions and purchases are told apart by the transfer flag, in both modes.**
  Contributions are transfers in the goal category; purchases are non-transfer expenses in
  the goal category. The user categorizes the trip's flights as the goal's category.
- **"Spending account" label.** Limits mode reuses `Account.onBudget` to know which side of a
  transfer is the spending side. The account form shows the toggle in both modes.
- **Starting amount is kept in both modes.** Limits mode labels it "Already saved". ZBB labels
  it "Already saved in off-budget accounts", with a hint that money in on-budget accounts should
  be assigned to the goal's category instead, so it isn't counted twice.
- **Covered goal spending is left out of the expense pie**, so the slices still add up to the
  expense total. It shows on the goal card instead.
- **Schema change approved** by the owner ("update the plan and start implementation").

Also decided while planning:

- **One goal per category, category required.** The create form can create a new category
  inline ("Trip to Japan") or pick an existing one. `categoryId` is unique on the goal.
- **Rounding reuses `allocateSpread` from `lib/spread.ts`.** This month's need is the first
  share of `allocateSpread(remainingCents, m, monthsLeft)`, so the extra cents go to the
  earliest months and the schedule always sums exactly to the remaining amount.
- **Past the target month and not reached:** the whole remainder is due in the current month
  and the goal shows as overdue. It is not auto-closed.
- **Reaching the target** marks the goal funded (derived, not stored). The user archives it
  manually once they've used the money. `archivedAt` hides it from the budget views but its
  coverage of spending still applies.

## The model

Notation: `c` = the goal's category, `m` = YYYYMM month, `T` = target amount, `S0` =
`startingAmount`, `G` = goal `startMonth` (the month it was created), `D` = `targetMonth`.

### Contributions

- **Limits mode:** transactions in `c` with `isTransfer = true` on spending accounts
  (`onBudget = true`). EXPENSE adds, INCOME subtracts.

  Only the spending side counts because a matched transfer has two legs. If the user
  categorizes both legs (chequing EXPENSE and savings INCOME), counting both would cancel to
  zero. Counting only the chequing side also works when the savings account isn't imported;
  the user marks that lone leg as a transfer with the existing toggle.

- **ZBB:** `assigned(c, m)`. Moving money out of the goal is a negative assignment and lowers
  progress. Transfers to off-budget accounts in `c` are category activity in ZBB but don't
  change progress, because progress is what was assigned, not what's left in the envelope.

### Progress, need and schedule

```
contributed(m)   = per mode, above (0 before G)
progressBefore(m)= S0 + sum of contributed(k) for G <= k < m
saved(m)         = progressBefore(m) + contributed(m)
monthsLeft(m)    = monthsBetween(m, D) + 1          // 1 in the target month itself
remaining(m)     = max(0, T - progressBefore(m))
need(m)          = 0 if remaining is 0
                 = remaining(m) if m > D
                 = allocateSpread(remaining(m), m, monthsLeft(m))[0]
schedule(m)      = allocateSpread(remaining(m), m, monthsLeft(m))
```

`progressBefore(m)` deliberately excludes month `m`, so this month's need doesn't shrink as the
user contributes. Spending from the goal never lowers progress, so paying a trip deposit early
doesn't make the goal look behind.

### Status

Checked in this order:

- `NOT_STARTED` when `m < G`.
- `FUNDED` when `saved(m) >= T`.
- `OVERDUE` when `m > D`.
- `BEHIND` when `progressBefore(m) < sum of planned shares for G <= k < m`, where the plan is
  `allocateSpread(T - S0, G, monthsBetween(G, D) + 1)`, rebuilt from the goal's current
  fields so editing the target or date resets it. Comparing totals keeps rounding cents from
  flipping the status, and this month's own contributions don't change it.
- `ON_TRACK` otherwise, including when ahead.

### Spending from a goal and coverage

```
goalSpend(m)  = non-transfer EXPENSE in c dated in m (m >= G), any account
covered(m)    = min(goalSpend(m), max(0, saved(m) - sum of covered(k) for G <= k < m))
uncovered(m)  = goalSpend(m) - covered(m)
```

`covered(m)` is left out of every expense aggregate for month `m`. `uncovered(m)` stays in as a
normal expense under the goal's category. Within a month, coverage is applied to the goal's
transactions in date order so day bars know which rows are covered.

Spread and reimbursable expenses in a goal category aren't covered in v1; they keep counting
as normal expenses through their existing rules.

### Worked example (limits mode)

Goal: **Trip to Japan**, $3,000 by August 2027, created October 2026, no starting amount. That
is 11 months. The user has a chequing account (spending) and a savings account (not spending).

| Month    | Saved before | Months left | Need    | What the user does                                               | Counted  |
| -------- | ------------ | ----------- | ------- | ---------------------------------------------------------------- | -------- |
| Oct 2026 | $0.00        | 11          | $272.73 | Transfers $272.73 chequing to savings, categorized Trip to Japan | +$272.73 |
| Nov 2026 | $272.73      | 10          | $272.73 | Forgets                                                          | $0       |
| Dec 2026 | $272.73      | 9           | $303.03 | Behind ($545.46 planned so far). Transfers $500                  | +$500.00 |
| Jan 2027 | $772.73      | 8           | $278.41 | Still behind ($818.19 planned so far). Transfers $278.41         | +$278.41 |
| Mar 2027 | ...          | ...         | goes up | Moves $200 savings to chequing for a car repair, Trip to Japan   | −$200.00 |
| Aug 2027 | $3,000       | 1           | $0      | Books $1,400 flights and $1,200 hotel, categorized Trip to Japan | spend    |

- Each month's contribution shows as Saved on the Overview and lowers that month's net.
- In August the $2,600 is covered by the goal: August's expenses don't go up, and the goal
  card shows $2,600 spent, $400 left. If the trip cost $3,300, $300 would count as an August
  expense.

### Worked example (ZBB)

Same goal. Carryover doesn't shrink the monthly amount, because progress is what was assigned,
not the envelope's balance. Existing limit targets top up to the balance; goals don't.

| Month | Carried in | Assigned before | Need    | You do                                      | Available after |
| ----- | ---------- | --------------- | ------- | ------------------------------------------- | --------------- |
| Oct   | $0         | $0              | $272.73 | Assign $272.73                              | $272.73         |
| Nov   | $272.73    | $272.73         | $272.73 | "Assign to targets" adds $272.73 (not $0)   | $545.46         |
| Dec   | $545.46    | $545.46         | $272.73 | Assign $500 (ahead)                         | $1,045.46       |
| Jan   | $1,045.46  | $1,045.46       | $244.32 | Being ahead lowers it                       | ...             |
| Feb   | ...        | ...             | same    | Pay a $400 flight deposit from the envelope | drops by $400   |

The Feb deposit lowers available but not progress, so the need doesn't rise, the goal isn't
behind, and the $400 isn't counted in February's spending.

### Switching modes

Goals live in their own table, so switching is non-destructive. Progress is recomputed with the
active mode's contributions. A starting amount entered in limits mode for money that's in
chequing would be counted twice once assigned in ZBB; the mode switch confirmation mentions
that goals are recalculated and starting amounts should be reviewed.

## Where it shows up

- **Budgets page, both modes:** a "Savings goals" section with goal cards and an "Add goal"
  button. Card: progress bar to `T`, saved / target, this month's need vs contributed, months
  left, status badge, spent from goal, schedule disclosure, edit / archive / delete.
- **ZBB rows:** goal categories show "Goal $3,000 by Aug 2027" and use `need(m)` as the target.
  "Assign to targets" tops goal categories up with `max(0, need(m) - assigned(c, m))` and limit
  categories with the existing formula.
- **ZBB Overview insights:** target shortfall includes goal shortfalls.
- **Overview hero:** new `saved` figure; `net = income - expense - saved`. Expense, pie, day
  bars and drilldowns leave covered goal spending out.
- **Trends:** monthly expense bars and category lines leave covered goal spending out.
- **Account form:** `onBudget` toggle shown in both modes as "Spending account".

## Data model

```prisma
model SavingsGoal {
  id             String    @id @default(cuid())
  userId         String
  categoryId     String    @unique
  targetAmount   Decimal   @db.Decimal(12, 2)
  targetMonth    Int
  startMonth     Int
  startingAmount Decimal   @default(0) @db.Decimal(12, 2)
  archivedAt     DateTime?
  createdAt      DateTime  @default(now())
  updatedAt      DateTime  @updatedAt

  user     User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  category Category @relation(fields: [categoryId], references: [id], onDelete: Cascade)

  @@index([userId])
}
```

Name comes from the category. Deleting the category deletes the goal (cascade).

## Services and contracts

- `lib/budgets/savings-goal-math.ts` (pure, integer cents): `computeGoalMonth`,
  `plannedBefore`, `coverageByMonth`.
- `lib/services/savingsGoals.ts`:
  - `listSavingsGoals(userId, month, { includeArchived })` → `FrontendSavingsGoal[]`
  - `createSavingsGoal(userId, input)`, `updateSavingsGoal`, `setSavingsGoalArchived`,
    `deleteSavingsGoal`
  - `getGoalMonthSummary(userId, month)` → per goal category: need, contributed, covered;
    plus the month's total saved. Used by overview, trends, zero-based.
  - `getGoalCoverageInRange(userId, from, to)` → covered cents per category per month, for
    Trends.
- `budgets.ts`: `createBudget` rejects a goal category.
- `zeroBased.ts`: goal need as target with `targetKind`, `assignToTargets` uses the kind.
- `zero-based-math.ts`: `targetTopUps` accepts a kind per category.
- `overview.ts`, `trends.ts`: leave covered goal spending out, add `saved` to the hero.
- `userData.ts`: export/import goals, bump format version to 3, accept 1 and 2.

Validation (`ServiceValidationError`):

- Category belongs to the user, has no goal yet, has no `Budget` limit.
- `targetAmount > 0`, `0 <= startingAmount < targetAmount`.
- `targetMonth >= startMonth`, at most 10 years out.
- The category can't be changed on update.

## Routes

- `app/api/savings-goals/route.ts`: `GET ?month=` list, `POST` create.
- `app/api/savings-goals/[id]/route.ts`: `PATCH` update or archive, `DELETE`.

## Test plan

Unit:

- `savings-goal-math`: even split, remainder cents to earliest months, catching up after a
  missed month, getting ahead, funded, target month, overdue, not started, behind vs on track
  (worked example numbers), coverage with partial and excess spending across months.
- `savingsGoals` service: limits contributions (transfer legs on spending accounts only,
  income subtracts, non-transfer ignored, before start ignored), ZBB contributions from
  assignments, ownership, goal and limit mutual exclusion, archive.
- `budgets`: limit on goal category rejected.
- `zeroBased`: goal need as target, `assignToTargets` goal formula.
- `overview` / `trends`: covered goal spending excluded, uncovered excess included, saved and
  net.
- `userData`: round trip with goals, v2 import still works.

E2E (`tests/e2e/savings-goals.spec.ts`): create a goal with a new category in limits mode,
see the monthly need, add a contribution transfer, see progress move; archive and delete;
validation error for a category with a limit.

## Implementation checklist

- [x] Owner decisions locked
- [ ] Prisma model + migration
- [ ] `lib/budgets/savings-goal-math.ts` + unit tests
- [ ] `lib/validators/savings-goals.ts` + unit tests
- [ ] `lib/services/savingsGoals.ts` + unit tests
- [ ] `budgets.ts` mutual exclusion
- [ ] ZBB integration (targets, assign to targets, insights)
- [ ] Overview and Trends: saved figure, coverage exclusion
- [ ] API routes
- [ ] UI: goals section and dialog on Budgets (both modes), ZBB row marker, hero saved figure,
      spending account toggle in both modes
- [ ] Data export/import v3
- [ ] E2E spec
- [ ] `npm run format:fix && npm run lint`, `npm run test`, `npm run test:e2e`
