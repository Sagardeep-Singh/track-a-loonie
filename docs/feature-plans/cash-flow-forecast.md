# Cash-flow forecast

Status: requirement spec. Nothing here is built yet. v1 needs no schema change; it depends on the
recurring-transactions spec (`recurring-transactions-and-subscriptions.md`) for most of its
inputs.

## Problem

The app tells a user where their money went. It doesn't tell them where it's going. Questions
users can't answer today:

- "Will my chequing account dip below $0 before payday?"
- "Can I afford this $600 purchase this week, or should it wait until the 15th?"
- "When will my credit card statement land, and will I have enough to pay it?"

Everything needed is close: account balances (`listAccounts`), statement cycles
(`lib/statement.ts`), budgets and zero-based assignments, and (once built) recurring series.

## Users and stories

1. As a user, I see a projected daily balance for each on-budget cash account (chequing,
   savings, cash) for the next 30, 60 or 90 days.
2. As a user, I see the events that move the line: expected paycheques, bills, subscriptions,
   credit card payments and remaining budgeted spending.
3. As a user, I get a warning when an account is projected to go below a threshold I set
   (default $0), with the date and the event that causes it.
4. As a user, I add a one-off planned item ("$600 car repair on the 12th") to see its effect,
   without creating a real transaction.
5. As a user, I see a compact "Lowest point in the next 30 days" figure on the dashboard.

## Scope (v1)

- **Accounts:** on-budget CHECKING, SAVINGS and CASH accounts that don't track balance by
  updates. Credit cards and lines of credit feed in through their payment events, not as lines.
- **Starting point:** today's balance from `listAccounts` (starting balance + transactions to
  date).
- **Events:**
  - Confirmed recurring series (income and bills) on the account they hit, stepped forward
    from `anchorDate` by cadence.
  - Credit card payments: for each card with a `statementDay`, the statement balance at the
    next close, due a configurable number of days later (default 21), paid from the account the
    user picks once per card.
  - Remaining discretionary spending: for each budgeted category without a recurring series,
    `max(limit - spent, 0)` spread evenly over the days left in the month, from a default
    spending account. Zero-based mode uses `available` instead of `limit - spent`.
  - Planned items the user added for the forecast.
- **Output:** per account, an ordered list of days with opening balance, events and closing
  balance, plus the lowest balance and its date.
- **UI:** a `/forecast` page with a line chart per account (reusing the
  `balance-line-chart.tsx` style), an event list, a range picker (30/60/90) and the low-balance
  warning. Dashboard gets a small "Lowest point" card.

## Non-goals (v1)

- Investment growth, interest, or FX.
- Probabilistic ranges ("80% likely between…").
- Auto-moving money or suggesting transfers.
- Forecasting balance-tracked accounts (RRSP, TFSA and so on).
- Forecasting further than 90 days.

## Acceptance criteria

- With a $1,000 chequing balance, a $2,000 biweekly paycheque next Friday and a $1,500 rent
  series on the 1st, the chart shows each event on its date and the closing balances match the
  running sum to the cent.
- A projected dip below the threshold shows "Chequing goes to -$230 on Dec 1 (Rent)" on the
  page and on the dashboard card.
- Removing or ending a recurring series removes its future events.
- Planned items appear on their date, can be edited or deleted, and never show in the ledger,
  budgets or Trends.
- Today's balance on the forecast equals the balance shown on the Accounts page.
- With no recurring series and no budgets the page shows an empty state explaining what feeds
  the forecast, not a flat misleading line.
- "Today" uses the viewer's timezone (`todayIn` from the timezone fix).

## Proposed design

### Schema

None for the projection itself. Two small additions need approval:

- `ForecastPlannedItem { id, userId, accountId, date, amount, type, label }` for story 4.
- Per-user settings: low-balance threshold, default spending account, and per-card "paid from"
  account plus days-to-due. Could live on a new `UserForecastSettings` row, or on `Account`
  (`paymentSourceAccountId`, `paymentDueDays`).

### Services

- `lib/forecast/project.ts` (pure): takes starting balances, events and a date range, and
  returns the daily series and low points. All cents, fully unit-tested.
- `lib/services/forecast.ts`: gathers inputs (accounts, recurring `listUpcoming`, statement
  periods from `lib/statement.ts`, budgets or ZBB available, planned items) and calls the pure
  projector. One read per source, bounded by the range.

### API

- `GET /api/forecast?days=30|60|90`
- `POST|PATCH|DELETE /api/forecast/planned-items[/id]`
- `PATCH /api/settings/forecast`

## Dependencies and sequencing

1. Recurring transactions (series + `listUpcoming`) ship first. Without them the forecast only
   has card payments and budget spend-down, which is too thin to be useful.
2. The viewer-timezone fix (PR #116) for a correct "today".

## Open questions

1. Is spreading remaining budget evenly per day right, or should it be front-loaded or weekly?
2. Days from statement close to payment due: one default (21) or per card?
3. Should savings accounts be on the chart by default or opt-in?
4. Planned items: allow repeating ones, or keep them one-off and push users to recurring series?

## Checklist

- [ ] Owner approves scope, open questions and the two small schema additions
- [ ] Recurring transactions shipped
- [ ] Architect pass: event sources, card payment model, performance
- [ ] UI spec: forecast page, chart, warning, dashboard card
- [ ] Test plan (unit: projector edge cases, service assembly; e2e: dip warning, planned item)
- [ ] Pure projector + tests
- [ ] Service, validators, routes + tests
- [ ] UI
- [ ] Tester review
