# Codebase Review — 2026-09-17

Scope: `main` @ `8da1e28` (post PR #57, PWA + push reminders merged). Full read-through of `app/`, `components/`, `lib/`, `prisma/schema.prisma`, auth config, and CI. Covers design, architecture, performance, security, and code duplication. No code changes made — findings only. Re-checked 2026-09-18 (through PR #66) and 2026-09-23 (through PR #67, BYOK LLM categorization) — see the update blocks below each finding for current status.

## Summary

Overall the codebase is disciplined and consistent: every service scopes by `userId`, Zod
validates every request boundary, money is handled in cents to avoid float drift, and the
service layer never leaks raw Prisma models. The issues below are mostly about **scale** (a few
queries that load a user's _entire_ history instead of a bounded window) and **repetition** (the
same small pieces of logic re-typed in multiple services/components instead of shared). No
critical vulnerabilities found.

| Severity | Count |
| -------- | ----- |
| High     | 0     |
| Medium   | 4     |
| Low      | 7     |

## Update — 2026-09-23 (re-checked against `main`, post PR #67 — BYOK LLM categorization)

Re-verified every finding against current `main` (`b53f525`, BYOK LLM-assisted transaction
categorization — the only commit since the 2026-09-18 update). No finding below flipped from open
to fixed and none regressed in a way that changes its severity; the picture is: two duplication
findings grew in scope again (more routes, more hand-rolled `fetch` sites), the env-flag-footgun
finding's predicted third copy **did not** materialize (worth noting as a miss on my part — see
below), and the new feature itself is a clean example of the patterns this review already asks
for elsewhere (typed errors, no raw Prisma leak, `userId`-scoped AAD encryption, a real bounded
rate limit).

| Severity | Count | Fixed | Still open |
| -------- | ----- | ----- | ---------- |
| High     | 0     | —     | —          |
| Medium   | 4     | 2     | 2          |
| Low      | 7     | 0     | 7          |

Notable from PR #67 (not a new numbered finding — noted here as context):

- **Good — new code follows the review's own asks.** `lib/crypto/secrets.ts` (AES-256-GCM,
  `userId` as AAD so a copied ciphertext blob fails to decrypt under another user's key,
  versioned `v1:` packing for future key rotation) and `lib/services/aiCategorize.ts`'s DB-backed
  daily suggestion cap (`AI_DAILY_SUGGEST_LIMIT`) are both well-scoped, typed, and unit-tested.
  The provider base-URL override (`AI_ANTHROPIC_BASE_URL`/`AI_OPENAI_BASE_URL`) is read only from
  server env, never request input, so it doesn't reopen an SSRF path. None of this changes any
  finding below, but it's evidence the architecture/security patterns called out as "Good" in
  sections 1–2 are holding up under new feature work, not just legacy code.
- **The 2026-09-18 update's prediction about the env-flag footgun (finding 1, second bullet) did
  not come true, and that's worth being explicit about.** It expected `available: false when
SECRET_ENCRYPTION_KEY is unset` to repeat the `remindersAvailable` boolean-prop pattern.
  Instead `SettingsPage` calls `getAiSettings(userId)` server-side and lets the service's own
  `isSecretEncryptionConfigured()` check (with real shape validation, not just presence — see
  `lib/crypto/secrets.ts` comment) decide availability, no parallel boolean prop threaded through.
  So the finding's underlying point (no shared helper/pattern for env-gated features) still
  stands, but the specific third-copy risk flagged last time was avoided in this instance.

---

## Update — 2026-09-18 (re-checked against `main`)

Re-verified every finding below against current `main` (through PR #66). Both Medium performance
findings are fixed; everything else — architecture, security, and duplication — is unchanged.
One finding (`listTransactions` pagination) has grown in scope since publication: PR #60 built
the Transactions page's search/filter/period/running-balance/summary logic entirely client-side
over the full unbounded result set, so the fix is no longer a query-shape change but a
server-side-aggregation feature. Flagged inline below and re-prioritized.

| Severity | Count | Fixed | Still open |
| -------- | ----- | ----- | ---------- |
| High     | 0     | —     | —          |
| Medium   | 4     | 2     | 2          |
| Low      | 7     | 0     | 7          |

Fixed since publication:

- Finding 3.2 (CSV import unbounded dedupe scan) — #61
- Finding 3.3 (`matchTransfers` unbounded scan, and its manual-trigger path never having a bound
  to begin with) — #61 bounded the query; #62 gave the manual "Match transfers" button a
  date-range picker so it has a bound to pass
- Finding 3.4 (`matchTransfers`'s N sequential `$transaction` calls) — #61

---

## 1. Architecture & Design

**Good:**

- Clean layering is actually followed: route handler → Zod validator → service → Prisma singleton (`lib/db/prisma.ts`). No business logic found leaking into route handlers.
- Services consistently return `Frontend*` shaped DTOs, never raw Prisma rows (`lib/services/transactions.ts:toFrontend`, similarly in `reimbursements.ts`, `budgets.ts`, etc.).
- Cross-field validation is split correctly: self-contained rules live in Zod refinements (`lib/validators/transactions.ts:refineReimbursable`), state-dependent rules live in the service (`lib/services/transactions.ts:updateTransaction`). This is a good, deliberate split and it's applied consistently.
- Reimbursement status/money math is centralized in `lib/services/reimbursements.ts` (`toCents`/`fromCents`/`deriveReimbursementStatus`) and reused by `transactions.ts` rather than re-derived — this one is done right.

**Findings:**

- **[Low] No middleware-level auth gate — relies on per-route/per-layout discipline.** There's no `middleware.ts`; `app/(protected)/layout.tsx` redirects unauthenticated users, and each of the 29 API routes independently calls `getServerAuthSession()` and checks `session?.user`. Today this is consistently applied (verified — every route except the NextAuth handler and the bearer-token-gated cron route checks it), but the pattern has no structural enforcement: a new route that forgets the check will silently ship. Consider a small `requireSession()` helper (see duplication section) that at least makes the omission a visible one-liner to review, if not a route-level middleware matcher.

  **Update 2026-09-18 — still open, and larger now.** 5 more route files landed since publication (`settings/account`, `settings/export`, `settings/import`, plus 2 more), each with its own hand-copied check — now **34 route files, 32 doing the manual guard** (up from 29). No `middleware.ts`, no `requireSession()`/`requireUserId()` helper added; every new route still repeats the pattern correctly by hand, but the "no structural enforcement" risk this finding calls out has only grown with the route count.

  **Update 2026-09-23 — still open, larger again.** PR #67 (BYOK LLM categorization) added 5 more route files (`categorize/suggest-ai`, `settings/ai`, `settings/ai/disclosure`, `settings/ai/model`, `settings/ai/toggles`) — now **39 route files, 37 doing the manual guard**, 51 individual `if (!session?.user)` checks across them (several files export multiple HTTP methods, each re-guarded). Every one of the 5 new files got the check correctly by hand, same as before. Still no `middleware.ts`/`requireSession()` helper.

- **[Low] `RemindersSection`'s availability gate is a footgun for anyone adding a feature behind an env flag.** `app/(protected)/settings/page.tsx` passes `remindersAvailable={Boolean(process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY)}` — this is fine, but it's exactly the pattern that broke CI for PR #57 (the e2e job didn't set the var, so the gated UI silently didn't render, and 4 tests timed out waiting for it). Worth a one-line comment at the flag's definition pointing at what env vars gate it, so the next optional-feature flag doesn't repeat the CI gap.

  **Update 2026-09-18 — still open.** The line is unchanged, no comment added. Worth resurfacing now: the BYOK LLM-categorization feature currently being planned (`docs/feature-plans/byok-llm-assisted-categorization.md`) will add exactly this pattern again (`available: false` when `SECRET_ENCRYPTION_KEY` is unset) — good opportunity to fix this finding and the new flag's own e2e-gap risk in the same PR instead of adding a third copy of the footgun.

  **Update 2026-09-23 — still open, but the predicted third copy didn't land.** PR #67 shipped; `SettingsPage` gates the AI section by calling `getAiSettings(userId)` server-side rather than threading a boolean `aiAvailable` prop the way `remindersAvailable` does — see the top-of-file 2026-09-23 update for detail. The underlying finding (no comment at `remindersAvailable`'s definition, no shared pattern for env-gated features) is still exactly as open as before; the specific repeat this update predicted just happened not to occur this time.

---

## 2. Security

**Good:**

- Every service method takes `userId` as its first argument and scopes every Prisma query by it; ownership is also re-checked server-side on update/delete (`assertOwnedRefs` in `transactions.ts`, `findFirst({ id, userId })` pattern used everywhere) rather than trusting a client-supplied ID.
- Password hashing uses bcrypt at 12 rounds (`lib/services/password.ts:BCRYPT_ROUNDS`); change-password requires the current password and rejects a same-as-current new password.
- The cron endpoint (`app/api/cron/reminders/route.ts`) uses a constant-time `timingSafeEqual` comparison (hashed first, so lengths never leak) and fails **closed** (500) if `CRON_SECRET` is unset — good default.
- No raw SQL (`$queryRaw`/`$executeRaw`) anywhere — all Prisma. No `eval`/`new Function`. The only `dangerouslySetInnerHTML` (`app/layout.tsx`) injects a static string literal, not user input — not exploitable.
- CSV import row counts are capped (`max(2000)` in `lib/validators/csv-import.ts`), so a huge-payload DoS via that endpoint is bounded.

**Findings:**

- **[Medium] No rate limiting anywhere, including login and signup.** `signInAction`/`signUpAction` (`lib/auth/actions.ts`) and the Credentials `authorize()` (`lib/auth/config.ts`) have no throttling. This is a self-hosted free multi-user app with public signup, so credential-stuffing / brute-force against `/login` and account-enumeration via signup ("email already exists" — worth checking that error message doesn't leak more than necessary) are both unmitigated. Recommend a lightweight IP+email based limiter (even an in-memory/Upstash-Redis token bucket) in front of the credentials provider and signup action.

  **Update 2026-09-18 — still open.** No limiter added anywhere in `lib/auth/`. Note for prioritization: the BYOK LLM-categorization design already includes a _different_, purpose-built rate limit (a DB-backed daily cap on AI suggestion calls, since that one guards a real per-request cost). This finding — auth brute-force protection — is unrelated and still fully unaddressed; don't let the new limiter read as covering this gap.

  **Update 2026-09-23 — still open; the predicted AI-suggestion limiter shipped, confirming this finding is unrelated and untouched.** PR #67 landed `AI_DAILY_SUGGEST_LIMIT` in `lib/services/aiCategorize.ts` (DB-backed, per-user daily cap on `suggestCategory` calls). It's well built but guards AI provider spend, not `/login`/`/signup`. `lib/auth/actions.ts` and `authorize()` in `lib/auth/config.ts` remain fully unthrottled.

- **[Low] No security headers configured.** `next.config.ts` only sets cache headers for `/sw.js`. There's no `X-Frame-Options`/`frame-ancestors` CSP, `X-Content-Type-Options: nosniff`, or `Referrer-Policy`. Vercel's platform defaults cover some of this, but for a finance app it's worth being explicit — clickjacking protection in particular (a transparent iframe over the login/settings pages) costs one `headers()` entry.

  **Update 2026-09-18 — still open.** `next.config.ts` is unchanged; still only the `/sw.js` cache-control entry.

  **Update 2026-09-23 — still open.** `next.config.ts` unchanged since last check.

- **[Low] `NEXTAUTH_SECRET`/session cookie hardening not verified in code.** JWT strategy is used (`session: { strategy: 'jwt' }` in `lib/auth/config.ts`) with no explicit `maxAge`, meaning it falls back to NextAuth's default (30 days) with no idle timeout. For a budget-tracking app with real financial data, a shorter session lifetime or activity-based expiry is worth considering — currently a stolen JWT is valid for a month regardless of inactivity.

  **Update 2026-09-18 — still open.** `lib/auth/config.ts` still sets `session: { strategy: 'jwt' }` with no `maxAge`.

  **Update 2026-09-23 — still open, unchanged.**

- **[Low] Signup has no email verification.** `createUser` (referenced from `lib/auth/actions.ts`) creates and immediately signs in a user off an unverified email. Low severity for a free personal-use app, but means the app will happily create accounts for emails the signer doesn't own — worth a conscious accept-the-risk note if not already decided.

  **Update 2026-09-18 — still open.** Unchanged; no verification step added to `signUpAction`.

  **Update 2026-09-23 — still open, unchanged.**

---

## 3. Performance

- **[Medium] `listTransactions` has no pagination and is called unbounded on the main Transactions page.** `app/(protected)/transactions/page.tsx:12` calls `listTransactions(userId, {})` — no `from`/`to`, and `lib/services/transactions.ts:listTransactions` has no `take`/`skip`/cursor. Every visit to `/transactions` loads **every transaction the user has ever logged**, each with 5 relations included (`account`, `category`, `importBatch`, both link sets). For a multi-year user this will get slow and memory-heavy on every page load. Needs either default date-bounding (e.g. last 3 months) with explicit "load more"/pagination, or a `take` cap with cursor-based paging.

  **Update 2026-09-23 — still open, no change to scope.** `listTransactions(userId, {})` and `transactions-view.tsx`'s client-side aggregation are both untouched by PR #67 (BYOK categorization touched `categorize-view.tsx`, not the Transactions page). The 2026-09-18 re-scoping still stands as written below.

  **Update 2026-09-18 — still open, and now a bigger fix than described here.** `listTransactions(userId, {})` is unchanged. But PR #60 (after this review was written) built the Transactions page's payee search, filter dialog, statement/month period picker, running balance, and credit/debit/net summary **entirely client-side** over that one unbounded `initialTransactions` array (`components/transactions/transactions-view.tsx`). Bounding the query now isn't a query-shape change — it would silently redefine what "All time" means, break the running balance (computed by summing the _whole_ filtered set), and break the summary totals, unless that aggregation moves server-side too. This is no longer the cheap fix the original wording implies; treat it as a small feature (server-side aggregation + pagination) sized closer to the "Suggested priority order" item below it than to #2/#3, which were genuinely one-line query bounds.

- **[Medium] CSV import loads the user's entire transaction history into memory for dedupe, on every preview _and_ every commit.** `lib/services/csvImport.ts:loadExistingKeys` runs `prisma.transaction.findMany({ where: { userId }, select: {...} })` with no date bound, building an in-memory `Set` from the full history — called once in `previewImport` and again in `commitImport`. This scales linearly with account age and runs twice per import. A `date`-windowed query (e.g. ±30 days around the CSV's min/max date) would cut this by orders of magnitude for established accounts, since duplicates can only exist near the import's own date range anyway.

  **✅ Fixed — #61.** `loadExistingKeys` now takes `dateFrom`/`dateTo` and bounds the query to the submitted rows' date range (±1 day pad), computed once and reused by both `previewImport` and `commitImport`.

- **[Low] `matchTransfers` also table-scans the user's full unmatched-transaction history** (`lib/services/transfers.ts:matchTransfers`, `findMany({ where: { userId, isTransfer: false, ... } })`, no date bound) and runs automatically after every CSV commit. Same fix shape as above — bound by the imported rows' date range ± the match window.

  **✅ Fixed — #61 + #62.** `matchTransfers` now accepts an optional `{ from, to }`, bounding the query to that range ± `MATCH_WINDOW_DAYS`. The CSV-commit call site (#61) passes the imported batch's date range. The manual "Match transfers" button on the Transactions page had no range to pass at all until #62 added a date-range picker (Week / Month / 6 months / Custom) in front of it — so the one call site this finding flagged as unfixable-by-query-bound-alone (no range available) now has one.

- **[Low] `matchTransfers` updates run as N sequential `$transaction` calls instead of one.** The final loop (`lib/services/transfers.ts`, `for (const [expenseId, incomeId] of pairs) { await prisma.$transaction([...]) }`) does one DB round-trip pair at a time. For a large import with many transfer pairs this serializes unnecessarily — collecting all updates into a single `prisma.$transaction([...])` call (or `Promise.all` of independent transactions) would cut round-trips from `2N` sequential awaits to one batch.

  **✅ Fixed — #61.** All pairs' updates are now `flatMap`'d into one `prisma.$transaction([...])` call.

- **[Low] `Budget.findMany` pulls every budget row ever created, not just the ones through the requested month.** `lib/services/budgets.ts:listBudgets` uses `month: { lte: month }` with no lower bound, relying on in-memory "keep the most recent per category" logic. Given budgets are one row per category per month, this is much smaller than the transactions cases above and likely fine in practice, but it's the same unbounded-query shape — flagging for consistency in case category count grows.

  **Update 2026-09-18 — still open.** `lib/services/budgets.ts:listBudgets` is byte-for-byte unchanged (`month: { lte: month }`, no lower bound).

  **Update 2026-09-23 — still open, unchanged.**

---

## 4. Code Duplication

- **[Low] The `if (!session?.user) return 401` guard is hand-copied into all ~29 API route handlers.** (e.g. `app/api/accounts/route.ts`, `app/api/transactions/route.ts`, `app/api/rules/route.ts`, ...) Every handler repeats:

  ```ts
  const session = await getServerAuthSession();
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  ```

  A small `requireUserId(): Promise<string | NextResponse>` (or a route-wrapping HOF) in `lib/auth/session.ts` would remove ~60 duplicated lines and — more importantly — make the auth check impossible to typo or forget silently, addressing the architecture finding above at the same time.

  **Update 2026-09-18 — still open, now ~64 duplicated lines across 32 routes** (up from ~29 routes / ~60 lines; see the architecture-section update above for the exact new route files).

  **Update 2026-09-23 — still open, now ~102 duplicated lines across 37 routes.** PR #67's 5 new AI route files (see architecture-section update above) bring the total to 39 route files / 37 with the manual guard / 51 individual `if (!session?.user)` checks (~2 lines each). Growth continues linearly with every feature PR, as predicted.

- **[Low] Month-key (`YYYYMM`) decomposition (`Math.floor(month / 100)`, `month % 100 - 1`) is reimplemented independently in four services**: `lib/services/budgets.ts:monthRange`, `lib/services/overview.ts:monthRange`, `lib/services/trends.ts` (two separate inline spots), and `lib/services/categorize.ts:getUncategorizedMonthSummary`. All four compute the same `{ start, end }` UTC date range from a `YYYYMM` int, with two subtly different return shapes (one also returns `daysInMonth`). Worth extracting to `lib/date.ts` (or similar) as a single `monthRange(month)` + optional `daysInMonth(month)`, since a UTC-boundary bug fixed in one copy (there's already careful UTC handling here) won't propagate to the other three.

  **Update 2026-09-18 — still open.** All four copies (`budgets.ts`, `overview.ts`, `trends.ts` ×2, `categorize.ts`) verified present, unchanged, still independent. No `lib/date.ts` added.

  **Update 2026-09-23 — still open, unchanged; PR #67 didn't touch month-key logic.**

- **[Low] Every client component hand-rolls its own `fetch` + JSON + error-handling boilerplate.** 13 components (`budgets-view.tsx`, `rules-view.tsx`, `reminders-section.tsx`, `accounts-view.tsx`, `change-password-form.tsx`, `reimbursement-link-picker.tsx`, `reimbursement-panel.tsx`, `transactions-view.tsx`, `categories-view.tsx`, ...) each write their own `fetch('/api/...', { method, headers: {'Content-Type': 'application/json'}, body: JSON.stringify(...) })` and then separately check `res.ok`. None of it is complex, but a tiny shared `lib/api-client.ts` (`postJSON`, `patchJSON`, `deleteJSON`) would remove the repeated header/stringify boilerplate and centralize error handling (e.g. consistent parsing of a service's `{ error: string }` response body, which today each component does slightly differently).

  **Update 2026-09-18 — still open.** No `lib/api-client.ts` exists. Component count moved sideways rather than down: `match-transfers-dialog.tsx` and the settings export/import/delete-account cards added new hand-rolled `fetch` call sites; nothing consolidated the existing ones. Still 11+ components doing this independently.

  **Update 2026-09-23 — still open, now 19 components.** PR #67 added two more independent hand-rolled `fetch` sites: `components/settings/ai-categorization-section.tsx` (5 call sites — key save/verify, toggles, model picker) and `components/settings/ai-disclosure-modal.tsx` (1). No `lib/api-client.ts` added; still no consolidation of any existing site.

- **[Low] `compileRuleMatcher`/matcher-compilation is correctly _not_ duplicated** — worth noting as a positive: `categorize.ts`, `csvImport.ts`, and `reimbursements.ts` all import the same `compileRuleMatcher` rather than re-implementing substring matching. Called out so it isn't mistaken for a gap during triage.

  **Update 2026-09-18 — still holds.** Unchanged; still one shared implementation, three importers.

  **Update 2026-09-23 — still holds.** Unchanged; PR #67's AI suggestion path (`lib/services/aiCategorize.ts`) is a separate, LLM-based suggestion mechanism and correctly does not reimplement or touch `compileRuleMatcher`.

---

## Suggested priority order

**Update 2026-09-23 — unchanged ordering, numbers refreshed.** No items moved: nothing on this
list was touched by PR #67 (BYOK categorization), which is unsurprising — it's a self-contained
new feature, not a fix to existing code. Items 3 and 6 keep growing simply because every feature
PR adds more routes / more components; that's the ordering argument for doing them sooner rather
than later, not a change in the argument itself.

1. ~~Bound `loadExistingKeys` / `matchTransfers` by date window~~ — **done, #61 + #62.**
2. Add basic rate limiting to login/signup — still the top open item; the BYOK feature's own
   AI-suggestion rate limit (`AI_DAILY_SUGGEST_LIMIT`) guards a different concern (provider spend)
   and doesn't touch this gap.
3. Extract `requireUserId()` helper — cheap, now removes ~37x duplication (was 32x), closes the
   "forgot the auth check" risk that's only gotten bigger as routes were added.
4. Extract shared `monthRange()` — cheap, removes a 4x duplicated date-math foot-gun.
5. Security headers (CSP/X-Frame-Options) — cheap, defense in depth.
6. Shared `fetch` client helper — nice-to-have, now 19x duplication, still lowest risk/impact.
7. **`listTransactions` pagination/server-side aggregation** — re-prioritized down and re-scoped
   up: per the finding above, this now requires moving the Transactions page's running
   balance/summary/period logic server-side alongside the date bound, not just adding a `take`.
   Worth scoping as its own small feature rather than folding into a quick-fix pass.

**Update 2026-09-18 — re-ordered.** Items 1 and 2 below were the "quick, mechanical" pair
(#61/#62 shipped exactly that shape); items 3–6 are unchanged and untouched; the original #1
(`listTransactions`) is deliberately moved to the bottom of "still open" — it's no longer the
quick win it looked like when this list was first written.
