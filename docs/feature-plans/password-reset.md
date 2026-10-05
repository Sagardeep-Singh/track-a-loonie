# Password reset (forgot password)

Let a signed-out user who forgot their password set a new one through an emailed, one-time link. Logged-in password change already exists (`change-password.md`); this is the signed-out path.

## Scope

- Login page gets a "Forgot password?" link to `/forgot-password`.
- `/forgot-password`: email field. Submitting always lands on the same "check your inbox" confirmation, whether or not the address has an account (same no-enumeration rule as signup, see `signup-email-enumeration.md`).
- Inbox outcomes, decided server-side:
  - Account with a password: email with a reset link to `/reset-password?token=…`, valid for 1 hour.
  - Google-only account (no `passwordHash`): email telling them to sign in with Google. No token, no password gets set.
  - No account: nothing is sent.
- `/reset-password?token=…`: new password + confirm (confirm is client-only). Invalid or expired tokens show an error with a link back to `/forgot-password` instead of the form.
- On success: token deleted, `passwordHash` replaced, `emailVerified` stamped if still null (a used link proves mailbox control, same reasoning as `consumeVerificationToken`), redirect to `/login?passwordReset=1` with a confirmation banner.
- Token handling mirrors `EmailVerificationToken`: 32 random bytes, only the SHA-256 hash is stored, one row per user (requesting again replaces the earlier link).
- Rate limits: per IP (10/hour) on the request action, per address (3/hour) on sends. Over the per-address limit it skips silently so the response stays identical.
- When Brevo isn't configured the link is hidden on the login page and `/forgot-password` says resets aren't available on this deployment.

Email normalization: every address is trimmed and lowercased (`normalizeEmail` / `emailField` in `lib/validators/email.ts`) on signup, credentials login, Google sign-in, password reset, and the bootstrap/seed scripts. Migration `20261005130000_normalize_user_emails` lowercases existing rows and aborts with a query to find them if two accounts would collide, so those can be resolved by hand first.

## Non-goals

- Revoking sessions on other devices (JWT strategy, same caveat as change-password).
- Setting a first password for Google-only users.
- Rate limiting attempts on the reset page itself (a 256-bit token isn't guessable).

## Logging

Every branch logs one `[password-reset] <event> key=value` line so a missing email can be traced. Fields are user ids, `tokenRef` (first 12 hex chars of the stored `tokenHash`, so `WHERE "tokenHash" LIKE '<ref>%'` finds the row), Brevo `messageId`, and error names/codes. Never the address, the raw token, or a raw error message.

- Request: `request.rejected reason=ip-rate-limit`, `request.skipped reason=email-not-configured|per-address-rate-limit`, `request.no-account`, `request.google-only`, `token.issued`, `request failed: <name> <code>` (action catch).
- Send: `email.sent kind=reset|google-notice messageId=…`, `email.failed … error=… reason=…`.
- Reset page and submit: `token.checked status=valid|invalid|expired`, `reset.rejected reason=invalid|expired|used-concurrently`, `reset.completed`.

`info` lines go to stdout and `warn`/`error` to stderr.

## Schema

New `PasswordResetToken` model (same shape as `EmailVerificationToken`) + migration `add_password_reset_token`.

## Files

**New**

- `prisma/migrations/20261005120000_add_password_reset_token/migration.sql`
- `lib/services/passwordReset.ts` — `requestPasswordReset(email)`, `getPasswordResetTokenStatus(rawToken)`, `resetPassword(input)`, `isPasswordResetConfigured()`.
- `lib/email/password-reset-email.ts`, `lib/email/password-reset-google-email.ts`
- `app/(auth)/forgot-password/page.tsx`, `app/(auth)/reset-password/page.tsx`
- `components/auth/forgot-password-form.tsx`, `components/auth/reset-password-form.tsx`
- `tests/unit/services/passwordReset.test.ts`, `tests/unit/lib/password-reset-email.test.ts`, `tests/e2e/password-reset.spec.ts`

**Modified**

- `prisma/schema.prisma` — new model + `User.passwordResetToken` relation.
- `lib/validators/password.ts` — `forgotPasswordSchema`, `resetPasswordSchema` sharing the existing new-password rule.
- `lib/auth/actions.ts` — `requestPasswordResetAction`, `resetPasswordAction`.
- `app/(auth)/login/page.tsx` — "Forgot password?" link, `passwordReset=1` banner.
- `app/(auth)/login/page.tsx` — brand panel pulled into `components/auth/auth-aside.tsx` so the two new pages reuse it.

## Test plan

**Unit (`tests/unit/services/passwordReset.test.ts`)**

- `requestPasswordReset`: no-op when email isn't configured; no-op for an unknown address; skips silently when the per-address limit is hit; Google-only user gets the "use Google" email and no token; password user gets a token upsert keyed by `userId` with a 1h expiry and a reset email whose link carries the raw token (not the hash); send failures propagate.
- `getPasswordResetTokenStatus`: `invalid` for unknown, `expired` past `expiresAt`, `valid` otherwise.
- `resetPassword`: throws for unknown and expired tokens (and deletes the expired row); on success hashes the new password, deletes the token in the same transaction, stamps `emailVerified` only when null.

**Unit (validators, emails)**

- `resetPasswordSchema` rejects short / >72-byte passwords and an empty token; `forgotPasswordSchema` rejects a malformed email.
- Both email builders: subject, link present and HTML-escaped, expiry copy in the reset email.

**E2E (`tests/e2e/password-reset.spec.ts`)**

- Happy path: sign up, request a reset from the login page link, follow the emailed link, set a new password, see the banner, sign in with the new password; old password fails.
- Unknown email shows the same confirmation as a real one.
- Mismatched confirmation shows an inline error.
- Invalid token shows the error state with a link to request a new one.
- A used link can't be reused.

## Checklist

- [x] Plan
- [x] Schema + migration
- [x] Validators
- [x] Email builders
- [x] Service
- [x] Server actions
- [x] Pages + forms, login link + banner
- [x] Unit tests
- [x] E2E spec
- [x] format:fix, lint, unit tests, e2e
- [x] Debug logging on the request, send and reset paths
- [x] Normalize emails on every write and lookup, migrate existing rows
