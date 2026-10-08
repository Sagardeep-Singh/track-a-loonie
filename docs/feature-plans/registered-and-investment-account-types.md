# Registered and Investment Account Types

## Goal

Let users create accounts for Canadian registered plans and other common account kinds so their full picture lives in one place: RRSP, TFSA, FHSA, RESP, RRIF, LIRA, non-registered investment, and line of credit (LOC).

## Scope

Types and labels only. Balances keep coming from `startingBalance` + transactions, exactly like today. No contribution room, no market value, no holdings.

## Non-goals

- Contribution room / annual limits per plan type.
- Market value, gains/losses, or holdings tracking.
- Tax slips, withdrawal rules, or locked-in restrictions (LIRA/RRIF minimums).
- Spousal RRSP or joint ownership modelling.

## Decisions / assumptions

- **New enum values** on `AccountType`: `RRSP`, `TFSA`, `FHSA`, `RESP`, `RRIF`, `LIRA`, `INVESTMENT` (non-registered), `LINE_OF_CREDIT`. Schema change is required by this task (Postgres enum, additive migration via `ALTER TYPE ... ADD VALUE`). No data backfill.
- **Single source of truth for type metadata** in a new `lib/account-types.ts`, replacing the duplicated label maps and `z.enum([...])` lists. Each entry carries:
  - `label` (e.g. `'RRSP'`, `'Non-registered investment'`, `'Line of credit'`)
  - `group`: `'Banking' | 'Credit' | 'Registered' | 'Investment'`
  - `isLiability`: true for `CREDIT_CARD` and `LINE_OF_CREDIT`
  - `defaultOnBudget`: false for `SAVINGS`, all registered types and `INVESTMENT`; true otherwise (LOC included, since LOC draws are usually day-to-day spending)
- **LOC behaves like a credit card where it matters:** inverted CSV sign convention in `lib/import.ts` (the comment there already mentions LOC), "owing" display on the accounts page, and the `isPayment` checkbox on income transactions. Code switches from `type === 'CREDIT_CARD'` to `isLiabilityAccountType(type)` at those sites.
- **Statement cycles stay credit-card only.** `statementDay` validation and the Month/Statement toggle are untouched. (See open questions.)
- **Net worth** on the accounts page keeps summing all balances. Registered and investment accounts are assets, so this works as is.
- **Accounts page grouping:** cards are grouped under `group` headings (Banking, Credit, Registered, Investment) in that order; empty groups are hidden. Account form select uses `<optgroup>` with the same groups.
- **Data export/import** (`lib/validators/user-data.ts`) accepts the new values via the shared enum, so exports from newer versions round-trip. Older exports still import fine since the change is additive.

## Data model change

- `AccountType` enum gains 8 values. No new columns.

## Implementation checklist

- [x] `prisma/schema.prisma`: add enum values; `npm run prisma:migrate -- --name add_registered_account_types`; `npm run prisma:generate`
- [x] `lib/account-types.ts`: `ACCOUNT_TYPES` metadata map, `ACCOUNT_TYPE_VALUES` tuple, `ACCOUNT_TYPE_GROUPS` order, helpers `isLiabilityAccountType(type)`, `defaultOnBudgetFor(type)`, `accountTypeLabel(type)`
- [x] `lib/validators/accounts.ts` + `lib/validators/user-data.ts`: build `z.enum` from `ACCOUNT_TYPE_VALUES`
- [x] `lib/services/accounts.ts` + `lib/services/userData.ts`: replace `type !== 'SAVINGS'` with `defaultOnBudgetFor(type)`
- [x] `lib/import.ts`: `resolveImportedTransactionType` uses `isLiabilityAccountType`
- [x] `components/import/import-view.tsx`, `components/transactions/transactions-view.tsx` (payment-related only, not statement toggle), `lib/transactions/use-transaction-form.ts`: `CREDIT_CARD` checks that are about liability behaviour switch to `isLiabilityAccountType`
- [x] `components/accounts/account-form.tsx`: grouped `<optgroup>` select driven by metadata; on-budget default from `defaultOnBudgetFor`
- [x] `components/accounts/accounts-view.tsx`: drop local `TYPE_LABELS`, use `accountTypeLabel`; group cards by `group`; "owing" via `isLiabilityAccountType`
- [x] Unit tests (`tests/unit/lib/account-types.test.ts`): every enum value has metadata; liability and on-budget defaults per type
- [x] Unit tests (`tests/unit/services/accounts.test.ts`): create RRSP defaults to off-budget; create LOC defaults to on-budget; explicit `onBudget` overrides; `statementDay` rejected on LOC
- [x] Unit tests (`tests/unit/lib/import.test.ts`): LOC uses inverted sign convention; TFSA uses debit convention
- [x] E2E (`tests/e2e/account-types.spec.ts`): create a TFSA and a LOC, see them under Registered / Credit headings with correct labels and "owing" on the LOC
- [x] `npm run format:fix && npm run lint`, `npm run test`, `npm run test:e2e`
- [x] Update `docs/feature-plans/budget-tracker-mvp.md` data model sketch with the new enum values

## Implementation notes

- Open questions below went with the proposed defaults: no `statementDay` on LOC, groups named Banking / Credit / Registered / Investment, single net worth number.
- `accountTypeGroup(type)` was added alongside the planned helpers for the accounts page grouping.
- The "Add an account" tile now sits in its own row below the grouped cards.
- Migration was hand-written (`ALTER TYPE ... ADD VALUE`) and verified with `prisma migrate deploy` plus `prisma migrate diff` (no drift) on a local Postgres 16.

## Open questions

1. Should LOC also support `statementDay` and the statement view? Most LOCs bill monthly, but interest-only payments make "statement period" less useful than for cards. Proposed default: no, revisit if asked.
2. Group order and naming on the accounts page: is "Banking / Credit / Registered / Investment" right, or should registered plans sit under a single "Investments" heading?
3. Should the net worth card split assets vs liabilities now that there are two liability types? Proposed default: leave as a single number for this change.
