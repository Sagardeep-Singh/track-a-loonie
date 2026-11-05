# Transaction filters: searchable multi-select

## Problem

`components/transactions/transaction-filters-dialog.tsx` renders every account
and every category as a checkbox row. Accounts have no height cap at all, and
categories are capped at `max-h-40` but still scroll. A user with 30+ categories
has to scroll a small box inside a modal to find one, and there's no way to
type a name. On mobile the dialog itself gets long enough to scroll too, so
there are nested scroll areas.

## Goal

Replace both checkbox lists with a compact, searchable multi-select so the
dialog stays short no matter how many accounts or categories exist.

## Proposed UX

Closed state (one line per field, same height as an `Input`):

- Trigger button shows `All accounts` / `All categories` when nothing is
  picked, the name when one is picked, or `3 selected` otherwise.
- Once two or more items are picked, they render as small removable chips
  under the trigger (each chip has an `×` button labelled `Remove <name>`).
  At most 4 chips show, then `+N more`, which opens the panel. A single pick
  needs no chip, since the trigger already shows its name.

Open state (expands inline below the trigger, inside the dialog):

- Search input, autofocused, placeholder `Search categories`.
- List of options filtered by a case-insensitive "contains" match on name,
  with a checkbox mark per row. List is capped at roughly 6 rows (`max-h-56`).
- Selected options are sorted to the top when the panel opens (not re-sorted
  while toggling, so rows don't jump under the cursor).
- Footer row: `Clear` (empties this field's selection), an `N of M selected`
  count, and `Done` (closes).
- Empty search result shows `No matches`.

Why inline and not a floating popover: the dialog is a native `<dialog>` in
the top layer, and an absolutely positioned popover inside it gets clipped or
needs the Popover API plus manual positioning. An inline panel needs no
positioning code, works the same on mobile, and only one field can be open at
a time so the dialog height stays bounded.

## Keyboard and accessibility

Follows the WAI-ARIA combobox + multi-select listbox pattern:

- Trigger: `button` with `aria-expanded`, `aria-controls`, and a visible
  label via the existing `Label`.
- Search input: `role="combobox"`, `aria-autocomplete="list"`,
  `aria-activedescendant` pointing at the highlighted option.
- List: `role="listbox"` with `aria-multiselectable="true"`; options are
  `role="option"` with `aria-selected`.
- Up/Down move the highlight, Enter or Space toggles it, Home/End jump.
- Escape closes the panel and returns focus to the trigger. It must call
  `preventDefault()` so the native dialog's `cancel` doesn't also close the
  whole Filters dialog. A second Escape closes the dialog as today.
- Opening one field closes the other.

## Scope of change

Frontend only. No service, validator, API, URL param, or schema changes.
`TransactionFilters.accountIds` / `categoryIds` keep their shape, so the draft,
Apply, Reset, and URL sync logic in the dialog stay as they are.

### Files

- `components/ui/multi-select.tsx` (new): generic
  `MultiSelect<{ id: string; name: string }>` with props `id`, `label`,
  `options`, `selectedIds`, `onChange`, `allLabel`, `searchPlaceholder`,
  `open`, `onOpenChange`. Open state is lifted so the dialog can enforce
  "one open at a time".
- `lib/ui/multi-select.ts` (new): pure helpers, so the logic is unit
  testable without a DOM:
  - `filterOptionsByQuery(options, query)`: trims, case-insensitive contains.
  - `orderSelectedFirst(options, selectedIds)`: stable, selected on top.
  - `summarizeSelection(options, selectedIds, allLabel)`: trigger text.
- `components/transactions/transaction-filters-dialog.tsx`: swap the two
  checkbox blocks for `MultiSelect`, add `openPicker: 'accounts' | 'categories' | null`
  state. `toggleId` moves to the helpers as `toggleSelectedId`.

### Dependencies

None added. The repo has no headless UI library today and this is one small
component. See open question 1.

## Acceptance criteria

- Accounts and categories each render as a single trigger plus chips; no
  checkbox list is visible until the trigger is clicked.
- Typing in the search narrows the list; clearing it restores the full list.
- Toggling options updates the draft only; nothing changes on the page until
  Apply, and closing the dialog without Apply still discards edits.
- Reset clears both selections (unchanged behaviour).
- Selected IDs that no longer exist (deleted category in a stale URL) are
  ignored in the trigger text and chips, matching today's checkbox behaviour.
- Fully keyboard operable as described above; Escape inside the panel doesn't
  close the dialog.
- Works at 375px wide with no horizontal scroll.
- Filter counts on the Filters button are unchanged.

## Test plan

Unit (`tests/unit/lib/multi-select.test.ts`):

- `filterOptionsByQuery`: empty and whitespace query return all; case
  insensitive; substring in the middle matches; no match returns `[]`;
  original order preserved.
- `orderSelectedFirst`: selected first, relative order kept in both groups;
  unknown selected IDs ignored.
- `summarizeSelection`: none -> all label; one -> its name; many -> `N selected`;
  stale IDs not counted.

E2E (extend `tests/e2e/transaction-filters-dialog.spec.ts`):

- Open Filters, open Categories, type part of a name, select it, Apply: only
  matching rows show and the filter count increments.
- Remove a selection via its chip, Apply: filter cleared.
- Escape inside the open panel closes only the panel; dialog stays open.
- Search with no matches shows `No matches`.

E2E (extend `tests/e2e/mobile-transaction-filters.spec.ts`):

- Same select-and-apply path at mobile viewport, no horizontal overflow.

## Non-goals

- No "Uncategorized" option inside the category picker (the existing
  `Uncategorized only` checkbox stays).
- No category groups/parents (not in the schema).
- No change to the type pills, amount range, or toggle checkboxes.
- Not reusing this component elsewhere in this PR (rules, budgets, etc.).

## Decisions

Implemented with the recommended answers to the open questions:

1. Hand-rolled component, no new dependency.
2. Accounts use the picker too, for consistency.
3. Inline expanding panel, not a floating popover.

## Checklist

- [x] Settle open questions (recommended answers, see Decisions)
- [x] `lib/ui/multi-select.ts` helpers + unit tests
- [x] `components/ui/multi-select.tsx`
- [x] Wire into `transaction-filters-dialog.tsx`, one panel open at a time
- [x] Extend desktop and mobile e2e specs
- [x] Update `transactions-pagination.spec.ts`, which ticked the old checkboxes
- [x] `npm run format:fix && npm run lint`, `npm run test`, `npm run test:e2e`
