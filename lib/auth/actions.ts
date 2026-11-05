'use server';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { APIError } from 'better-auth/api';
import { auth } from '@/lib/auth/auth';
import { createUser } from '@/lib/services/users';
import { signUpSchema } from '@/lib/validators/signup';
import { forgotPasswordSchema, resetPasswordSchema } from '@/lib/validators/password';
import { ServiceValidationError } from '@/lib/services/common';
import { requestPasswordReset, resetPassword } from '@/lib/services/passwordReset';
import { checkRateLimit, RateLimitedError } from '@/lib/services/rateLimit';
import { clientIpFromHeaders } from '@/lib/http/clientIp';
import { normalizeEmail } from '@/lib/validators/email';
import {
  isEmailVerificationConfigured,
  issueAndSendVerificationEmail,
  sendAccountExistsEmail,
} from '@/lib/services/emailVerification';

const TOO_MANY_ATTEMPTS = 'Too many attempts. Try again in a few minutes.';

// Credential-stuffing/brute-force guard for the one unauthenticated action
// that checks a password. Two scopes so a single leaked-password list run
// against many emails (IP-scoped) and repeated guesses against one account
// (email-scoped) are both bounded, independently of each other.
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_EMAIL_LIMIT = 10;
const LOGIN_IP_LIMIT = 30;

// Account-creation abuse guard: bounds how many accounts one source can spin
// up, independent of the tighter per-login-attempt limits above (signup is
// a rarer action than login, so a looser window with a lower cap is enough).
const SIGNUP_WINDOW_MS = 60 * 60 * 1000;
const SIGNUP_IP_LIMIT = 5;

// Per-address sends are capped in the service; this bounds how many
// addresses one source can spray reset emails at.
const PASSWORD_RESET_WINDOW_MS = 60 * 60 * 1000;
const PASSWORD_RESET_IP_LIMIT = 10;

// The e2e suite logs in as the same dev user dozens of times per run across
// many specs and creates far more accounts than any real signup source
// would. These limits exist to stop abuse, not a shared-account test suite.
// Server-only env var, read once at module load, never request input.
const rateLimitDisabled = process.env.E2E_DISABLE_RATE_LIMIT === '1';

const signOutTo = async (redirectTo: string): Promise<never> => {
  await auth.api.signOut({ headers: await headers() });
  redirect(redirectTo);
};

export const signOutAction = async (): Promise<void> => {
  await signOutTo('/login');
};

export const signOutAfterPasswordChange = async (): Promise<void> => {
  await signOutTo('/login?passwordChanged=1');
};

export const signOutAfterAccountDeletion = async (): Promise<void> => {
  await signOutTo('/login?accountDeleted=1');
};

/**
 * Starts a Google sign-in and sends the browser to Google. Errors (e.g. a
 * Google account whose email matches an unverified local account, which
 * Better Auth refuses to link) come back to `errorCallbackURL` as `?error=`.
 */
const redirectToGoogle = async (
  callbackURL: string,
  options: { forceLogin?: boolean } = {},
): Promise<never> => {
  const { url } = await auth.api.signInSocial({
    body: { provider: 'google', callbackURL, errorCallbackURL: '/login' },
    headers: await headers(),
  });
  if (!url) {
    throw new Error('Google sign-in did not return a redirect URL.');
  }
  const target = new URL(url);
  if (options.forceLogin) {
    target.searchParams.set('prompt', 'login');
  }
  redirect(target.toString());
};

/**
 * Forces Google to re-show its authentication screen even when its own IdP
 * session cookie is still active — `prompt=login` is what makes this a real
 * "prove you still control this account" step rather than a no-op redirect
 * that `select_account` alone would be. Better Auth only sets `prompt` per
 * provider, so it's added to the authorization URL here. Completing it
 * creates a new session, and that session's age is what
 * `deleteUserAccount` checks for a Google-only user
 * (lib/services/accountDeletion.ts).
 */
export const reauthenticateWithGoogleAction = async (): Promise<void> => {
  await redirectToGoogle('/settings', { forceLogin: true });
};

export const signInAction = async (
  _prevState: string | undefined,
  formData: FormData,
): Promise<string | undefined> => {
  const rawEmail = formData.get('email');
  const password = formData.get('password');
  if (typeof rawEmail !== 'string' || typeof password !== 'string') {
    return 'Incorrect email or password.';
  }
  const email = normalizeEmail(rawEmail);

  // Checked before the user lookup so a guess against a nonexistent email
  // still counts — otherwise account enumeration would be free.
  if (!rateLimitDisabled) {
    const ip = clientIpFromHeaders(await headers());
    try {
      await checkRateLimit('login:ip', ip, LOGIN_IP_LIMIT, LOGIN_WINDOW_MS);
      await checkRateLimit('login:email', email, LOGIN_EMAIL_LIMIT, LOGIN_WINDOW_MS);
    } catch (error) {
      if (error instanceof RateLimitedError) {
        return TOO_MANY_ATTEMPTS;
      }
      throw error;
    }
  }

  try {
    await auth.api.signInEmail({ body: { email, password }, headers: await headers() });
  } catch (error) {
    if (error instanceof APIError) {
      return 'Incorrect email or password.';
    }
    throw error;
  }
  redirect('/dashboard');
};

export const signInWithGoogleAction = async (): Promise<void> => {
  await redirectToGoogle('/dashboard');
};

export const signUpAction = async (
  _prevState: string | undefined,
  formData: FormData,
): Promise<string | undefined> => {
  const parsed = signUpSchema.safeParse({
    name: formData.get('name'),
    email: formData.get('email'),
    password: formData.get('password'),
  });
  if (!parsed.success) {
    return parsed.error.issues[0]?.message ?? 'Check the form and try again.';
  }

  if (!rateLimitDisabled) {
    const ip = clientIpFromHeaders(await headers());
    try {
      await checkRateLimit('signup:ip', ip, SIGNUP_IP_LIMIT, SIGNUP_WINDOW_MS);
    } catch (error) {
      if (error instanceof RateLimitedError) {
        return TOO_MANY_ATTEMPTS;
      }
      throw error;
    }
  }

  // New and already-registered emails get the exact same response, so the
  // form can't be used to check whether an address has an account. The
  // difference only shows up in the inbox: a verification link for a new
  // account, a "you already have an account" notice otherwise. That's also
  // why there's no auto sign-in here: landing on /dashboard would give it away.
  const { id, created } = await createUser(parsed.data);

  // Best-effort: a Brevo outage shouldn't turn into a form error (and an
  // error on only one path would leak which path ran). Verification can
  // always be retried from the unverified-email banner's resend button.
  try {
    if (created) {
      await issueAndSendVerificationEmail(id, parsed.data.email);
    } else {
      await sendAccountExistsEmail(parsed.data.email);
    }
  } catch {
    // swallowed deliberately, see comment above
  }

  redirect(`/login?signup=${isEmailVerificationConfigured() ? 'check-email' : 'done'}`);
};

export const requestPasswordResetAction = async (
  _prevState: string | undefined,
  formData: FormData,
): Promise<string | undefined> => {
  const parsed = forgotPasswordSchema.safeParse({ email: formData.get('email') });
  if (!parsed.success) {
    return parsed.error.issues[0]?.message ?? 'Check the form and try again.';
  }

  if (!rateLimitDisabled) {
    const ip = clientIpFromHeaders(await headers());
    try {
      await checkRateLimit(
        'password-reset:ip',
        ip,
        PASSWORD_RESET_IP_LIMIT,
        PASSWORD_RESET_WINDOW_MS,
      );
    } catch (error) {
      if (error instanceof RateLimitedError) {
        console.warn('[password-reset] request.rejected reason=ip-rate-limit');
        return TOO_MANY_ATTEMPTS;
      }
      throw error;
    }
  }

  // Same response for every address, including when Brevo fails: an error
  // on only one path would leak which path ran. Logged (name and Prisma code
  // only, never the message, which can echo the address) so a missing
  // migration or a Brevo outage isn't invisible.
  try {
    await requestPasswordReset(parsed.data.email);
  } catch (error) {
    const name = error instanceof Error ? error.name : 'unknown';
    const code =
      error instanceof Error && 'code' in error && typeof error.code === 'string'
        ? ` ${error.code}`
        : '';
    console.error(`[password-reset] request failed: ${name}${code}`);
  }

  redirect('/forgot-password?sent=1');
};

export const resetPasswordAction = async (
  _prevState: string | undefined,
  formData: FormData,
): Promise<string | undefined> => {
  const newPassword = formData.get('newPassword');
  if (newPassword !== formData.get('confirmNewPassword')) {
    return 'New password and confirmation do not match.';
  }

  const parsed = resetPasswordSchema.safeParse({ token: formData.get('token'), newPassword });
  if (!parsed.success) {
    return parsed.error.issues[0]?.message ?? 'Check the form and try again.';
  }

  try {
    await resetPassword(parsed.data);
  } catch (error) {
    if (error instanceof ServiceValidationError) {
      return error.message;
    }
    throw error;
  }

  redirect('/login?passwordReset=1');
};
