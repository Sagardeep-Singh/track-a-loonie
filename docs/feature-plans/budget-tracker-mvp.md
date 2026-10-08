# Budget Tracker MVP

## Goal

Minimal personal budgeting app: track accounts, log transactions (manual or CSV import), auto-categorize spend, set monthly category budgets, see budget-vs-actual at a glance. Single user. Public repo, GPLv3 (since relicensed to AGPLv3).

## Assumptions

- Single user (no multi-tenant / team features in MVP). Auth exists only to gate a publicly-hosted deployment.
- No live bank sync (e.g. Plaid) in MVP — CSV import covers bulk entry instead; noted as post-MVP.
- Auto-categorization is rule-based (user-defined keyword → category rules), not ML/external API. Keeps MVP dependency-free and deterministic; smarter matching is post-MVP.
- Postgres for all environments, dev included (local instance via `DATABASE_URL`).

## Stack

Next.js App Router, TypeScript, Prisma + Postgres, NextAuth (credentials, single user), Tailwind CSS, Zod, Vitest.

## MVP Feature Set

1. **Auth** — single-user login (credentials provider, seeded user, no self-signup).
2. **Accounts** — CRUD for accounts (checking, savings, credit card, cash), each with a running balance derived from transactions.
3. **Categories** — CRUD for spend categories (seed defaults: Groceries, Rent, Utilities, Transport, Dining, Income, Other); user can add/edit/delete.
4. **Transactions** — CRUD: date, amount, account, category, payee/note, type (income/expense). List view with filter by account/category/date range.
5. **Budgets** — set a monthly limit per category; view current-month actual spend vs limit (progress bar / over-budget flag).
6. **Dashboard** — current month summary: total income, total expense, net, per-category budget progress, recent transactions.
7. **Auto-categorization** — user-managed keyword rules (payee/note contains X → Category Y, ordered, first match wins); applied on CSV import and as a suggestion on manual entry (editable before save). Uncategorized rows fall back to "Other".
8. **CSV import** — upload CSV, map columns (date, amount, payee/note, optionally type), preview parsed rows with auto-assigned category, per-row include/exclude + category override, duplicate detection (same account+date+amount+payee) flagged before commit, batch insert.

## Explicitly out of scope for MVP (post-MVP backlog)

- Live bank sync (Plaid/Yodlee).
- ML-based categorization; only rule-based in MVP.
- Multi-user / shared households.
- Recurring transactions, bill reminders.
- Multi-currency.
- Charts/trends beyond current-month progress bars.
- Mobile app / PWA polish.

## Data Model (sketch)

- `User` (id, email, passwordHash)
- `Account` (id, userId, name, type, startingBalance, statementDay — credit cards only, see `docs/feature-plans/credit-card-statement-cycle.md`; type also covers line of credit, registered plans and non-registered investment, see `docs/feature-plans/registered-and-investment-account-types.md`)
- `Category` (id, userId, name, isDefault)
- `Transaction` (id, userId, accountId, categoryId, amount, type, date, note, payee, importBatchId?)
- `Budget` (id, userId, categoryId, month, limitAmount)
- `CategoryRule` (id, userId, categoryId, matchText, priority)

## Implementation Checklist

- [x] Scaffold Next.js + TypeScript + Tailwind + ESLint + Prettier project
- [x] Add Prisma, define schema (User/Account/Category/Transaction/Budget/CategoryRule), initial migration
- [x] Wire NextAuth credentials provider + seeded single user + protected route group
- [x] `lib/db/prisma.ts` singleton
- [x] Zod validators: account, category, transaction, budget, category-rule, csv-import
- [x] Services: `accounts.ts`, `categories.ts`, `transactions.ts`, `budgets.ts`, `categoryRules.ts`, `csvImport.ts`
- [x] Categorization engine: `lib/services/categorize.ts` — apply ordered rules to payee/note, fallback uncategorized; reused by manual-entry suggestion and CSV import
- [x] API routes under `app/api/` calling validators → services
- [x] Accounts UI: list/create/edit/delete
- [x] Categories UI: list/create/edit/delete, seed defaults on first run
- [x] Category rules UI: list/create/edit/delete with numeric priority (drag-to-reorder not built — numeric priority input covers the MVP need)
- [x] Transactions UI: list w/ filters, create/edit/delete form, category auto-suggested + overridable on entry
- [x] CSV import UI: upload → column mapping → preview (parsed rows, auto category, duplicate flags) → confirm/commit
- [x] CSV parsing: `papaparse`
- [x] Budgets UI: set monthly limit per category
- [x] Dashboard page: income/expense/net summary + budget progress + recent transactions
- [x] Unit tests for all services (Prisma mocked), incl. categorization rule matching and CSV import parsing/dedupe
- [x] README: setup, scripts
- [x] LICENSE (GPLv3, since relicensed to AGPLv3)
- [x] CI: lint + test on push (GitHub Actions)
