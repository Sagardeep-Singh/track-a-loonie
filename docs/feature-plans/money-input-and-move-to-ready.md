# Money input and Move to Ready to Assign

## Problem

- Zero-based: money carried into a category from earlier months isn't in this
  month's Assigned field, so pulling it back out meant typing a negative
  assignment by hand.
- Money fields were `type="number"`: spinner arrows, and pasting `6,303.89`
  was rejected by the browser.

## Approach

- Move money accepts Ready to Assign as either side (`READY_TO_ASSIGN` in
  `lib/budgets/zero-based-math.ts`). It has no cell, so only the real
  category's assignment changes; Ready to Assign follows from the math.
  "Move" on a row now defaults its destination to Ready to Assign.
- Shared `MoneyInput` (`components/ui/money-input.tsx`): text field with the
  decimal keypad, tabular digits, no spinners. Accepts commas and a pasted
  `$`, groups thousands on blur, and hands callers the plain amount (via
  `onValueChange`, or a hidden input for FormData forms). Parsing lives in
  `lib/ui/money-input.ts`.
- Whole-number fields (rule priority, statement day, spread months) stay
  `type="number"` with spinners hidden in `app/globals.css`.

## Checklist

- [x] `moveMoney` handles Ready to Assign on either side, with unit tests
- [x] Ready to Assign option in the Move dialog, default for "Move"
- [x] `MoneyInput` plus parsing helpers and unit tests
- [x] Swap every money field to `MoneyInput`
- [x] Hide spinners on remaining number fields
- [x] format, lint, unit and e2e suites
