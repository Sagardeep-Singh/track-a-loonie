import Link from 'next/link';
import { SourceLink } from '@/components/nav/source-link';
import { LoginForm } from '@/components/auth/login-form';
import { GoogleSignInButton } from '@/components/auth/google-sign-in-button';
import { isPasswordResetConfigured } from '@/lib/services/passwordReset';
import { AuthAside } from '@/components/auth/auth-aside';

const googleConfigured = Boolean(process.env.AUTH_GOOGLE_ID && process.env.AUTH_GOOGLE_SECRET);

const VERIFY_MESSAGES: Record<string, { text: string; tone: 'success' | 'error' }> = {
  verified: { text: 'Email verified. Thanks!', tone: 'success' },
  invalid: { text: "That verification link isn't valid.", tone: 'error' },
  expired: {
    text: 'That verification link expired — request a new one from Settings.',
    tone: 'error',
  },
};

// Better Auth sends failed Google sign-ins back here as `?error=<code>`.
const GOOGLE_ERROR_MESSAGES: Record<string, string> = {
  // An existing account with this email whose address isn't verified yet:
  // linking it to Google could hand it to whoever registered it.
  account_not_linked:
    "An account with this email already exists but isn't verified yet. Use the verification link we emailed you, or reset your password, then Google sign-in will work.",
  access_denied: 'Google sign-in was cancelled.',
};
const GOOGLE_ERROR_FALLBACK = "Google sign-in didn't finish. Try again.";

// Signup redirects here with the same `signup` value whether the email was
// new or already registered (lib/auth/actions.ts), so this copy must never
// imply one or the other.
const SIGNUP_MESSAGES: Record<string, string> = {
  'check-email': 'Thanks for signing up. Check your inbox for next steps, then sign in below.',
  done: 'If this email is new, your account is ready. Sign in to continue.',
};

const LoginPage = async ({
  searchParams,
}: {
  searchParams: Promise<{
    passwordChanged?: string;
    passwordReset?: string;
    verify?: string;
    signup?: string;
    error?: string;
  }>;
}): Promise<React.ReactElement> => {
  const { passwordChanged, passwordReset, verify, signup, error } = await searchParams;
  const googleError = error ? (GOOGLE_ERROR_MESSAGES[error] ?? GOOGLE_ERROR_FALLBACK) : undefined;
  const verifyMessage = verify ? VERIFY_MESSAGES[verify] : undefined;
  const signupMessage = signup ? SIGNUP_MESSAGES[signup] : undefined;

  return (
    <>
      <AuthAside />
      <div className="flex flex-col px-6 py-8 lg:items-center lg:justify-center lg:p-14">
        <div className="w-full lg:max-w-[360px] lg:animate-[fade-up_0.3s_ease-out]">
          <h2 className="font-display text-2xl font-semibold tracking-[-0.02em]">Sign in</h2>
          <p className="text-ink-muted mt-2 mb-6.5 text-[13.5px]">Welcome back.</p>
          {passwordChanged === '1' && (
            <p className="bg-sky-soft text-sky mb-4 rounded-lg px-3 py-2 text-sm" role="status">
              Password changed. Sign in with your new password.
            </p>
          )}
          {passwordReset === '1' && (
            <p className="bg-sky-soft text-sky mb-4 rounded-lg px-3 py-2 text-sm" role="status">
              Password reset. Sign in with your new password.
            </p>
          )}
          {signupMessage && (
            <p className="bg-sky-soft text-sky mb-4 rounded-lg px-3 py-2 text-sm" role="status">
              {signupMessage}
            </p>
          )}
          {googleError && (
            <p className="bg-rose-soft text-rose mb-4 rounded-lg px-3 py-2 text-sm" role="alert">
              {googleError}
            </p>
          )}
          {verifyMessage && (
            <p
              className={`mb-4 rounded-lg px-3 py-2 text-sm ${
                verifyMessage.tone === 'success' ? 'bg-sky-soft text-sky' : 'bg-rose-soft text-rose'
              }`}
              role="status"
            >
              {verifyMessage.text}
            </p>
          )}
          <LoginForm />
          {isPasswordResetConfigured() && (
            <p className="mt-3 text-right text-[13px]">
              <Link href="/forgot-password" className="text-iris font-medium">
                Forgot password?
              </Link>
            </p>
          )}
          {googleConfigured && (
            <>
              <div className="text-ink-muted my-5 flex items-center gap-3 text-xs">
                <span className="bg-line h-px flex-1" />
                or
                <span className="bg-line h-px flex-1" />
              </div>
              <GoogleSignInButton label="Continue with Google" />
            </>
          )}
          <p className="text-ink-muted mt-6 text-center text-[13.5px]">
            New here?{' '}
            <Link href="/signup" className="text-iris font-medium">
              Create an account
            </Link>
          </p>
          <SourceLink className="mt-8 text-center" />
        </div>
      </div>
      <p className="text-ink-muted px-6 pb-8 text-center text-[12.5px] lg:hidden">
        Your data stays in your account. No bank credentials are stored.
      </p>
    </>
  );
};

export default LoginPage;
