# Better Auth migration

Replace NextAuth v5 (beta) with Better Auth (`better-auth@1.7.x`) without changing what users see. This is step 1 of 3:

1. **This plan:** swap the auth library, keep behavior identical (plus the one gap fix below).
2. TOTP 2FA with backup codes, opt-in per user (`twoFactor` plugin). Separate plan.
3. Passkeys (`@better-auth/passkey`). Separate plan.

Why now: 2FA and passkeys are the next auth features. NextAuth has no 2FA, and its passkey support is experimental and needs a database adapter, which we dropped because `@auth/prisma-adapter` hardcodes `prisma.account` and collides with our bank `Account` model (see `google-email-signup.md`). Better Auth ships both as plugins and lets us rename its tables. NextAuth v5 also never left beta and Auth.js is now in maintenance mode.

## Scope

- Credentials (email + password) and Google sign-in move to Better Auth.
- Sessions move from a 7-day JWT to database sessions: 7-day expiry, refreshed at most daily (same numbers as today).
- Existing bcrypt hashes keep working. No password reset is forced on anyone.
- Signup, email verification, password reset, change password, and account deletion keep their current UX, copy, URLs for pages, and no-enumeration behavior.
- **Gap fix that comes for free:** changing or resetting a password signs out the user's other sessions. Today those JWTs stay valid for up to 7 days.

## Non-goals

- 2FA and passkeys (steps 2 and 3).
- Changing password hashing to scrypt. We keep bcrypt via Better Auth's `password.hash` / `password.verify` hooks. Rehashing can come later.
- A "manage sessions" UI. The data will exist, the screen is a later feature.
- New UI of any kind. Login, signup, reset and settings screens stay as they are.

## Decisions

| Area | Decision |
| --- | --- |
| Table names | Better Auth `account` model maps to Prisma `AuthAccount` (`account.modelName`). `user` stays `User`, `session` becomes `Session`, `verification` becomes `Verification`. No clash with the bank `Account` model. |
| IDs | Keep `cuid()` defaults. Set `advanced.database.generateId: false` so Prisma generates IDs. |
| Password storage | `User.passwordHash` moves to an `AuthAccount` row (`providerId: 'credential'`, `accountId: userId`, `password: <bcrypt hash>`). Hash and verify stay bcrypt, 12 rounds. |
| Sessions | Database sessions, `expiresIn` 7 days, `updateAge` 1 day. **No `cookieCache`**: it would let a deleted user's other devices keep working until the cache expires, which breaks the "delete takes effect everywhere immediately" rule in `lib/auth/config.ts`. Deleting a `User` cascades to `Session`, so a DB session lookup gives us that rule for free. |
| Server actions stay | Login, signup, reset, etc. stay as server actions in `lib/auth/actions.ts` and call `auth.api.*` with the `nextCookies()` plugin. Components and form contracts don't change. |
| Rate limiting | Keep `lib/services/rateLimit.ts` and the existing limits in the server actions. Better Auth's limiter doesn't run on server-side `auth.api.*` calls, and its default storage is in-memory (wrong for more than one instance). |
| Raw HTTP endpoints | Add `/sign-in/email`, `/sign-up/email`, `/request-password-reset`, `/reset-password`, `/change-password`, `/send-verification-email` and `/delete-user` to `disabledPaths` so nobody can call them directly and skip our rate limits and enumeration rules. `disabledPaths` only blocks the HTTP router, `auth.api.*` still works. `/api/auth/*` stays mounted for the Google callback, `get-session` and `sign-out`. |
| Signup | `autoSignIn: false` and `onExistingUserSignUp` sends the existing "account already exists" email. Same response for new and taken emails, no auto sign-in, same as today. `requireEmailVerification: false`: verification still never gates access. |
| Email verification | Better Auth's `sendVerificationEmail` hook calls our existing Brevo template. `sendOnSignUp: true`. The emailed link moves to Better Auth's `/api/auth/verify-email` with `callbackURL` pointing at `/login?verify=…`. Resend button keeps working through a server action. |
| Password reset | Better Auth's `sendResetPassword` hook calls our Brevo template with a link to our existing `/reset-password?token=…` page. In the hook: skip silently past 3 sends/hour per address (`checkRateLimit`), and send the "sign in with Google" email instead if the user has no credential account, without the token. `onPasswordReset` stamps `emailVerified` (a used link proves mailbox control, same as today). `revokeSessionsOnPasswordReset: true`. |
| Token storage | `verification.storeIdentifier: 'hashed'`, so reset tokens aren't stored in plain text (we store SHA-256 today). |
| Change password | `auth.api.changePassword` with `revokeOtherSessions: true`. Keep our validator and the "Google-only account has no password" and "new must differ" errors in `lib/services/password.ts`. |
| Google linking | `accountLinking.trustedProviders: ['google']`. Existing Google-only users already have `emailVerified` set, so their first Better Auth sign-in links a new `AuthAccount` row by email. Google's redirect URI stays `/api/auth/callback/google`, so the Google console needs no change. |
| Google re-auth for deletion | Replace the `reauthenticatedAt` JWT claim with the session's `createdAt`. A re-auth makes a new session, so "session created in the last 5 minutes" is the same proof. `signInSocial` returns the Google URL, and we append `prompt=login` before redirecting, since Better Auth only sets `prompt` per provider. |
| Session helpers | `getServerAuthSession`, `requireSession` and `requireUserId` in `lib/auth/session.ts` keep their signatures and wrap `auth.api.getSession({ headers })`. The ~60 call sites don't change. |
| Env vars | `BETTER_AUTH_SECRET` (new, generate fresh) and `BETTER_AUTH_URL`. `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET` stay and are passed in explicitly. Drop `AUTH_SECRET` after cutover. |

## Schema impact (needs sign-off)

One migration, `better_auth_migration`:

- `User`
  - `emailVerified DateTime?` becomes `emailVerified Boolean @default(false)`, backfilled with `"emailVerified" IS NOT NULL`. We lose the verification timestamp. Nothing reads it today (all reads are truthiness checks).
  - Add `image String?` and `updatedAt DateTime @updatedAt` (Better Auth core fields).
  - Drop `passwordHash` after copying it into `AuthAccount`.
  - Drop the `emailVerificationToken` / `passwordResetToken` relations, add `sessions` and `authAccounts`.
- New `AuthAccount`: `id, userId, accountId, providerId, password?, accessToken?, refreshToken?, idToken?, accessTokenExpiresAt?, refreshTokenExpiresAt?, scope?, createdAt, updatedAt`. `@@unique([providerId, accountId])`, `@@index([userId])`, cascade on user delete.
- New `Session`: `id, token @unique, userId, expiresAt, ipAddress?, userAgent?, createdAt, updatedAt`. `@@index([userId])`, cascade on user delete.
- New `Verification`: `id, identifier, value, expiresAt, createdAt, updatedAt`. `@@index([identifier])`.
- Data step: `INSERT INTO "AuthAccount" (id, "userId", "accountId", "providerId", password, …) SELECT …, id, id, 'credential', "passwordHash" … FROM "User" WHERE "passwordHash" IS NOT NULL`.
- Drop `EmailVerificationToken` and `PasswordResetToken`.
- `RateLimitBucket` stays.

`User.name` stays nullable. Better Auth types it as required, but we always pass a name on signup and Google provides one. Check during implementation that `getSession` returns a null name without throwing; if it doesn't work, backfill `name` from the email local part and make it required (another schema decision, raise first).

## Cutover effects (accepted unless flagged)

- Everyone is signed out once (old JWT cookies mean nothing to Better Auth).
- Verification and reset links already sitting in inboxes stop working. Both flows have a resend path.
- Take a DB backup before `prisma migrate deploy`. There's no down migration. Rolling back means restoring the backup and redeploying the previous build.

## Open questions

1. **Unverified credentials user signs in with Google.** Today that links the accounts and marks the email verified (`findOrCreateGoogleUser`). Better Auth refuses to link when the local row is unverified (`requireLocalEmailVerified`, defaults to on and becomes mandatory in the next minor). That refusal closes an account-takeover hole: someone pre-registers a victim's email with a password, then the victim's Google sign-in gets linked into it. **Recommendation:** accept it. The user verifies their email (or resets the password) once and Google linking works after that. Login page needs an error message for this case.
2. **2FA and Google sign-in (step 2, noted now).** Better Auth's `twoFactor` plugin only challenges email/password sign-ins, so Google sign-ins skip TOTP. That fits "optional TOTP" but should be stated in the step 2 plan.

## Files

- `package.json`: add `better-auth`, `@better-auth/prisma-adapter`, remove `next-auth`, `@auth/prisma-adapter`.
- `auth.ts` → `lib/auth/auth.ts`: `betterAuth({...})` config (replaces `lib/auth/config.ts`). Root `auth.ts` deleted.
- `lib/auth/auth-client.ts`: only if a client component needs it. Today none do, so probably not added.
- `app/api/auth/[...nextauth]/route.ts` → `app/api/auth/[...all]/route.ts` with `toNextJsHandler(auth)`.
- `app/api/auth/verify/route.ts`: deleted (Better Auth's `/verify-email` takes over). `verify/resend` keeps its route and calls `auth.api.sendVerificationEmail`.
- `lib/auth/session.ts`: wrap `auth.api.getSession`. Expose `sessionCreatedAt` instead of `reauthenticatedAt`.
- `lib/auth/actions.ts`: same exported actions, now calling `auth.api.*`. Error mapping stays (`Incorrect email or password.`, `Too many attempts…`).
- `lib/auth/errors.ts`: `AuthRateLimitedError` no longer extends NextAuth's `CredentialsSignin`. Plain error or deleted if the rate limit check moves fully into the action.
- `lib/auth/types.d.ts`: deleted (Better Auth infers session types).
- `lib/services/users.ts`: `createUser` and `findOrCreateGoogleUser` go away (Better Auth creates users). `userHasPassword` reads `AuthAccount`.
- `lib/services/password.ts`: delegate to `auth.api.changePassword`.
- `lib/services/passwordReset.ts`, `lib/services/emailVerification.ts`: shrink to the email-sending and logging parts used by the Better Auth hooks. Token creation, hashing and consumption go away.
- `lib/services/accountDeletion.ts`: read the password from `AuthAccount`, check `sessionCreatedAt` for Google-only users.
- `lib/services/userData.ts`: confirm export still excludes `AuthAccount`, `Session`, `Verification`.
- `prisma/schema.prisma` + migration (above).
- `prisma/seed.ts`, `prisma/bootstrap-admin.ts`: write the credential `AuthAccount` row instead of `passwordHash`.
- `proxy.ts`: no change (it doesn't touch auth).
- `.env.example` / README: new env vars.
- Tests listed below.

## Test plan

Unit (`tests/unit/...`), update existing and add:

- `auth-config.test.ts`: bcrypt hash and verify hooks accept an existing 12-round hash. Disabled paths list. No `cookieCache`.
- `auth-actions.test.ts`: sign-in maps a bad password and a rate-limited attempt to the same messages as today. Signup returns the same redirect for new and taken emails and never sets a session.
- `users.test.ts`, `password.test.ts`, `passwordReset.test.ts`, `emailVerification.test.ts`, `accountDeletion.test.ts`: rewritten against the new storage. Reset hook skips silently over 3/hour per address, sends the Google notice for Google-only accounts, stamps `emailVerified` on success. Change password revokes other sessions. Deletion accepts a Google-only user with a session under 5 minutes old and rejects an older one.
- `userData.test.ts`: export contains no password, session token or verification value.

E2E (`tests/e2e/...`), must pass unchanged: `login`, `signup`, `email-verification`, `password-reset`, `settings-data-management`. Add:

- Password change in one browser context signs out a second context.
- Account deletion in one context signs out a second context on its next request.
- Calling `POST /api/auth/sign-in/email` directly returns 404.

## Checklist

- [ ] Sign-off on schema changes and open question 1
- [ ] product-manager pass to confirm the behavior parity list
- [ ] software-architect review of this plan
- [ ] tester writes the unit and e2e test plans against it
- [ ] Add packages, write `lib/auth/auth.ts` and the catch-all route
- [ ] Schema + migration with the credential backfill, tested against a copy of real data
- [ ] Session helpers and server actions on `auth.api.*`
- [ ] Email verification and password reset hooks
- [ ] Change password, account deletion, Google re-auth
- [ ] Seed and bootstrap scripts
- [ ] Remove NextAuth packages and dead code
- [ ] Unit and e2e tests green, `npm run format:fix && npm run lint` clean
- [ ] Deploy notes: backup, new env vars, everyone signed out once
