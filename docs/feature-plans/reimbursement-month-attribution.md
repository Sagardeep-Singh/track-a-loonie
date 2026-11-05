# Reimbursement month attribution and transaction badges

## Problem

Reimbursements are netted out of the **expense's** month (see `reimbursable-expenses.md`). A
January expense reimbursed in March retroactively lowers January's spent, so closed months keep
shifting. Transactions also give no quick visual cue for a reimbursement, a card payment, a
transfer or a reimbursable expense.

## Decisions

- **Default: count a reimbursement in the month the money arrives** (the linked income's date).
  Past months no longer change when a late reimbursement is linked.
- **Per-user opt-in to the old behaviour**: `UserBudgetSettings.reimbursementsInExpenseMonth`
  (`Boolean @default(false)`), toggled from Settings → Budgeting. A missing settings row means
  the default.
- **Default math reduces category spent** in the arrival month (same as today, just a different
  month). Reimbursement income stays excluded from income in both modes.
- **Manual "mark fully reimbursed" top-ups stay in the expense's month** in both modes (there is
  no money-arrival date for them).
- **Overshoot never becomes credit**: in arrival-month mode each link is capped so the running
  total of reimbursements on one expense (oldest income first) never passes the expense amount.
- **Badges** in the transaction list (desktop and mobile): Reimbursement (income with links),
  Payment, Transfer, Reimbursable (with pending/reimbursed status, as today).

## Changes

- [x] `prisma/schema.prisma` + migration `add_reimbursement_attribution_setting`.
- [x] `lib/services/reimbursements.ts`: `listReimbursedAmountsByExpenseDate` becomes
      `listReimbursedAmounts(userId, start, end, inExpenseMonth)`; rows carry an attribution
      `date` (expense date, or income date in arrival mode) instead of `expenseDate`.
      `getReimbursementsInExpenseMonth(userId)` reads the setting.
- [x] `budgets.ts`: attribute by the new rows (already by category).
- [x] `overview.ts` / `trends.ts`: rows whose expense is in the same month keep per-transaction
      netting; the rest (expense in another month) subtract from that month's category and day
      totals, clamped at 0.
- [x] `zeroBased.ts`: activity cells use the row's attribution month.
- [x] `transactionsPage.ts` + `transaction-summary.ts`: in arrival mode Debit is gross (minus
      manual top-ups) less the reimbursement income in view, instead of netting each expense by
      all its links.
- [x] `zeroBased.ts` settings service + `PATCH /api/settings/reimbursement-attribution` +
      validator + toggle in `budgeting-section.tsx`.
- [x] Data export/import carries the new field (optional on import for older files).
- [x] Badges in `transactions-view.tsx` (`FrontendTransaction.isReimbursementIncome` already
      exists).
- [x] Unit tests: service attribution in both modes, overview/trends/budgets/summary updates.
- [x] E2E: `tests/e2e/reimbursement-attribution.spec.ts` (setting flips which month's budget
      drops) and badge checks in `tests/e2e/transactions-pagination.spec.ts`.

## Known trade-off

On Overview, a reimbursement for an earlier month's expense comes off its category first, then
off the day the money arrived, each clamped at 0. When that day had less spending than the
reimbursement, the day bars can add up to more than `hero.expense`.
