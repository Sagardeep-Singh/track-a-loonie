'use server';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { signIn, signOut } from '@/auth';
import { AuthError } from 'next-auth';
import { createUser } from '@/lib/services/users';
import { signUpSchema } from '@/lib/validators/signup';
import { forgotPasswordSchema, resetPasswordSchema } from '@/lib/validators/password';
import { ServiceValidationError } from '@/lib/services/common';
import { requestPasswordReset, resetPassword } from '@/lib/services/passwordReset';
import { checkRateLimit, RateLimitedError } from '@/lib/services/rateLimit';
import { clientIpFromHeaders } from '@/lib/http/clientIp';
import { AuthRateLimitedError } from '@/lib/auth/errors';
import {
  isEmailVerificationConfigured,
  issueAndSendVerificationEmail,
  sendAccountExistsEmail,
} from '@/lib/services/emailVerification';

const TOO_MANY_ATTEMPTS = 'Too many attempts. Try again in a few minutes.';

// Account-creation abuse guard: bounds how many accounts one source can spin
// up, independent of the tighter per-login-attempt limits in
// lib/auth/config.ts (signup is a rarer action than login, so a looser
// window with a lower cap is enough).
const SIGNUP_WINDOW_MS = 60 * 60 * 1000;
const SIGNUP_IP_LIMIT = 5;

// Per-address sends are capped in the service; this bounds how many
// addresses one source can spray reset emails at.
const PASSWORD_RESET_WINDOW_MS = 60 * 60 * 1000;
const PASSWORD_RESET_IP_LIMIT = 10;

// See lib/auth/config.ts's matching flag — same reasoning, the e2e suite
// creates far more accounts per run than any real signup source would.
const rateLimitDisabled = process.env.E2E_DISABLE_RATE_LIMIT === '1';

export const signOutAction = async (): Promise<void> => {
  await signOut({ redirectTo: '/login' });
};

export const signOutAfterPasswordChange = async (): Promise<void> => {
  await signOut({ redirectTo: '/login?passwordChanged=1' });
};

export const signOutAfterAccountDeletion = async (): Promise<void> => {
  await signOut({ redirectTo: '/login?accountDeleted=1' });
};

/**
 * Forces Google to re-show its authentication screen even when its own IdP
 * session cookie is still active — `prompt: 'login'` is what makes this a
 * real "prove you still control this account" step rather than a no-op
 * redirect that `select_account` alone would be. The `jwt` callback stamps
 * `token.reauthenticatedAt` on every completed Google sign-in, this one
 * included, which is what `deleteUserAccount` checks for a Google-only user
 * (lib/services/accountDeletion.ts).
 */
export const reauthenticateWithGoogleAction = async (): Promise<void> => {
  await signIn('google', { redirectTo: '/settings' }, { prompt: 'login' });
};

export const signInAction = async (
  _prevState: string | undefined,
  formData: FormData,
): Promise<string | undefined> => {
  try {
    await signIn('credentials', {
      email: formData.get('email'),
      password: formData.get('password'),
      redirectTo: '/dashboard',
    });
  } catch (error) {
    if (error instanceof AuthRateLimitedError) {
      return TOO_MANY_ATTEMPTS;
    }
    if (error instanceof AuthError) {
      return 'Incorrect email or password.';
    }
    throw error;
  }
};

export const signInWithGoogleAction = async (): Promise<void> => {
  await signIn('google', { redirectTo: '/dashboard' });
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
