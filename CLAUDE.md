# CLAUDE.md

Source of truth for project conventions, commands, and architecture.

## Project Overview

- Personal budget-tracking web app. Public GitHub repo, AGPLv3 licensed.
- Track accounts, transactions, categories, and monthly budgets; free multi-user app, every service scopes by `userId`.
- Strict TypeScript-safe changes; preserve established repo patterns.

## Response Rules

- Summarize changes in concise project terms.
- Report whether `npm run format:fix && npm run lint` and tests passed.
- Call out blockers, assumptions, or unrelated failures explicitly.

## Commands

```bash
npm run dev                          # dev server at localhost:3000
npm run build                        # production build
npm run lint                         # eslint
npm run format:fix                   # prettier write
npm run test                         # vitest single pass
npm run test:watch                   # vitest watch
npm run prisma:generate              # regenerate Prisma client after schema changes
npm run prisma:migrate -- --name <name>  # create and apply migration
npm run db:setup                     # generate + migrate + seed in one step
```

`npm run format` is check-only; use `npm run format:fix` to apply.

**After every code change:** run `npm run format:fix && npm run lint` and the test suite.

## Architecture

- `app/`: App Router pages, layouts, API route handlers.
- `components/`: UI components and client-facing interaction logic.
- `lib/services/`: business logic and Prisma queries.
- `lib/validators/`: Zod schemas for request/form data.
- `lib/db/`: Prisma client singleton and db helpers.
- `prisma/`: schema, migrations, seed data.

**Stack:** Next.js App Router, TypeScript, Prisma + Postgres, NextAuth (credentials + Google, multi-user), Tailwind CSS, Zod, Vitest.

**Request flow:** route handler → Zod validator → service → Prisma via `lib/db/prisma.ts` singleton. No business logic in handlers.

**Services:** own all business logic and Prisma queries. Return plain objects or throw typed validation errors. Never return raw Prisma models to the client.

**Auth:** NextAuth credentials + Google (Google shown only when `AUTH_GOOGLE_ID`/`AUTH_GOOGLE_SECRET` are set); anyone can sign up, isolation is via `userId` scoping (no roles/tenant system); all routes under `app/(protected)/` require session.

## Conventions

- Arrow functions with explicit return types on exported functions.
- Prisma access only through `lib/db/prisma.ts` singleton.
- `prisma/seed.ts` is destructive — local dev only.
- After schema changes: run `npm run prisma:generate`.

## Agent Workflow

Subagents in `.claude/agents/` for non-trivial feature work, in order:

1. **product-manager** — scope the feature, write user stories/acceptance criteria, flag open questions and non-goals. Invoke first for any non-trivial request.
2. **software-architect** — design the change: file breakdown, service/validator contracts, schema impact (flag, don't assume authorization). Invoke after product-manager for anything touching schema, services, or cross-cutting concerns.
3. **ui-designer** — component spec (tree, props/state, interaction states, accessibility) for any user-facing surface. Invoke after software-architect defines data contracts.
4. **tester (test plan)** — before any code changes, write a unit test plan (`tests/unit/...`, cases and expected behavior per new/changed service method) and, for any user-facing flow, an e2e test plan (`tests/e2e/...`, Playwright — key user paths, happy path plus error states). This is the acceptance bar the implementation is written against; hand it to senior-developer alongside the architect/UI plan.
5. **senior-developer** — implement file-by-file against the architect's plan (and UI spec, if any), satisfying the tester's test plan; writes the actual unit tests for new service methods and e2e specs for the planned flows; runs `npm run format:fix && npm run lint` and the test suite (`npm run test` and `npm run test:e2e`).
6. **tester (review)** — reviews the implementation against its own test plan, runs lint/unit/e2e tests, checks for missing coverage, tries to break it (empty inputs, boundary values, malformed input).

Skip steps for trivial changes (typo fixes, small copy edits) — go straight to editing.

## Rules

**Always:**

- Focus changes on the task; avoid unrelated refactors.
- Make only the changes the task needs and keep the diff as small as possible, without compromising code readability.
- Extend existing services, validators, and shared utilities before adding abstractions.
- Write a plan to `docs/feature-plans/` (kebab-case) before implementing non-trivial features, with a checklist (`- [ ] step`). Keep it updated through implementation.
- Add tests for new service methods.
- Raise ambiguity before making product, schema, or workflow decisions not implied by the task.

**Never:**

- Add business logic to route handlers.
- Return raw Prisma models from services.
- Modify generated output or build artifacts unless required.
- Change `prisma/schema.prisma` or migrations unless the task explicitly requires it.
- Run `git reset --hard` or `git checkout --` unless explicitly requested.
- Rename or move files unless necessary.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
