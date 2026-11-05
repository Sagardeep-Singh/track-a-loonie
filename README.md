# Track a Loonie

A small, honest personal budget tracker. Track accounts, log transactions (manually or via CSV
import), auto-categorize spend with your own rules, set monthly budgets per category, and see
where things stand.

Free to use — anyone can sign up with Google or an email/password/name and gets their own
isolated space. Every service scopes its data by user, so accounts stay fully separate.

## Stack

Next.js App Router, TypeScript, Prisma + Postgres, NextAuth (credentials + Google), Tailwind
CSS v4, Zod, Vitest.

## Getting started

```bash
cp .env.example .env   # fill in DATABASE_URL, NEXTAUTH_SECRET
npm install
npm run db:setup       # prisma generate + migrate + seed (destructive, local dev only)
npm run dev
```

Create an account at `/signup` (name, email, password) or sign in at `/login`. "Continue with
Google" appears once `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET` are set — see `.env.example` for how
to obtain them. A new sign-up starts with an empty dashboard — no starter categories, rules, or
accounts — you add your own.

For local development, `npm run db:setup` also seeds a known dev account from `ADMIN_EMAIL` /
`ADMIN_PASSWORD` in `.env`, prepopulated with sample categories/rules/an account for convenience
when testing — this isn't required for real usage, anyone can sign up from `/signup`.

AI-assisted categorization is opt-in and off by default. Set `SECRET_ENCRYPTION_KEY` (32 random
bytes, base64 — `openssl rand -base64 32`) to enable the "AI categorization" card in Settings,
where each user saves their own Anthropic or OpenAI API key. Keys are encrypted at rest with that
master key, excluded from data export, and never returned to the client. Left unset, the feature
is invisible. See `.env.example` for the optional `AI_ANTHROPIC_BASE_URL` / `AI_OPENAI_BASE_URL`
test overrides and `docs/runbooks/rotate-secret-encryption-key.md` for rotation.

Paid plans are opt-in too. With no `STRIPE_SECRET_KEY` billing is off and every user gets
every feature, which is the right setup for a self-hosted install. To turn it on (Free + Plus,
billed through Stripe):

1. In Stripe, create a Product per paid plan with a recurring Price, and give the Product this
   metadata: `plan=true`, `limit_accounts=unlimited`, `history_months=all`, `feature_trends=true`,
   `feature_reimbursements=true`, `feature_statement_cycles=true`, `feature_push_reminders=true`.
   A missing or malformed key falls back to the Free value (2 accounts, 12 months, no Plus
   features), which lives in `lib/billing/entitlements.ts`.
2. Set `STRIPE_SECRET_KEY`, `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` and `STRIPE_WEBHOOK_SECRET`.
3. Add a webhook endpoint at `<origin>/api/stripe/webhook` for `product.*`, `price.*`,
   `checkout.session.completed` and `customer.subscription.*` events. Locally, use
   `stripe listen --forward-to localhost:3000/api/stripe/webhook`.
4. Turn on the Customer Portal (Settings → Billing → Customer portal) so users can switch plans,
   update their card and cancel.
5. Run `npm run stripe:sync-plans` once to pull the existing products and prices in.

"Upgrade to Plus" links, including the one on the marketing pricing page, should point at
`<origin>/upgrade`. A signed-out visitor is sent through sign-in and brought back there.

For a production deploy: run `npm run prisma:deploy` to apply migrations. On serverless hosts,
set `DATABASE_PRISMA_DATABASE_URL` to a pooled connection URL (see `.env.example`), otherwise concurrent
function instances can hit "too many connections" on the direct `DATABASE_URL`. `npm run
prisma:bootstrap-admin` is optional — it seeds/updates one known account by email, useful for an
admin or demo login.

## Commands

See `CLAUDE.md` for the full command list and architecture notes.

## License

AGPLv3, see [LICENSE](./LICENSE). If you run a modified version for others, set `SOURCE_CODE_URL` to your modified source so the in-app "Source code" link points to it.
