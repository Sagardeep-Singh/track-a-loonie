# Transaction flag labels, payment/transfer exclusivity, reimbursement links

## Goal

- Ticking "Reimbursable" pre-fills the expected reimbursement with the transaction amount.
- The payment, transfer and reimbursable checkboxes get short labels with an info icon that opens a popover description.
- A transaction can't be both a card payment and a transfer.
- Income linked as a reimbursement lists the expenses it pays back, each linking to that expense.

## Decisions

- Labels: "Card payment", "Transfer", "Reimbursable".
- Expected amount: filled from the amount when the box is ticked and the field is empty. While it still matches the amount, it follows amount edits.
- Exclusivity: ticking one box clears the other. The validator rejects both in one payload, the update service rejects the merged state, and transfer matching skips card payments. Existing rows with both flags open with only "Card payment" ticked.
- Links: the income's detail drawer shows a "Reimburses" list. Each item links to `/transactions?from=<day>&to=<day>&tx=<id>`, and the view now opens the drawer when `tx` changes after mount, not only on first load.
- No schema change.

## Checklist

- [x] `components/ui/info-popover.tsx`: info button with an accessible popover (Escape and outside click close it)
- [x] `transaction-form.tsx` and `log-a-spend-mobile.tsx`: short labels and info popovers
- [x] `use-transaction-form.ts`: payment and transfer setters clear each other
- [x] `transaction-form.tsx`: default and sync the expected reimbursement from the amount
- [x] `lib/validators/transactions.ts`: reject `isPayment` + `isTransfer`
- [x] `lib/services/transactions.ts`: reject the merged payment + transfer state on update
- [x] `lib/services/transfers.ts`: skip card payments when matching
- [x] `lib/services/reimbursements.ts`: `listReimbursedExpenses(userId, incomeId)`
- [x] `app/api/transactions/[id]/reimbursed-expenses/route.ts`: GET route
- [x] `components/transactions/reimbursed-expenses-list.tsx` in the income drawer
- [x] `transactions-view.tsx`: open the drawer when `?tx=` changes
- [x] Unit tests for the validator, services and transfer matching
- [x] `npm run format:fix && npm run lint`, `npm run test`
