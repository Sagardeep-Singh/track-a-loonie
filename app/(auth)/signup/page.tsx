import Link from 'next/link';
import { SignUpForm } from '@/components/auth/signup-form';
import { GoogleSignInButton } from '@/components/auth/google-sign-in-button';
import { LogoMark } from '@/components/ui/logo-mark';
import { Ring } from '@/components/ui/ring';

// Forced dynamic so `googleConfigured` is read per-request, not baked into a
// static build — otherwise adding AUTH_GOOGLE_ID/SECRET later would need a
// rebuild for the button to appear.
export const dynamic = 'force-dynamic';

const SignUpPage = (): React.ReactElement => {
  const googleConfigured = Boolean(process.env.AUTH_GOOGLE_ID && process.env.AUTH_GOOGLE_SECRET);

  return (
    <>
      <div className="bg-iris-soft flex flex-col justify-between p-14">
        <div className="font-display flex items-center gap-2 text-[19px] font-semibold">
          <LogoMark size={24} variant="bare" />
          trackaloonie
        </div>
        <div>
          <Ring size="hero" fraction={0.56} />
          <h1 className="font-display mt-7 max-w-[400px] text-[34px] leading-[1.15] font-semibold tracking-[-0.025em]">
            Know what&rsquo;s left, not just what&rsquo;s gone.
          </h1>
          <p className="text-ink/75 mt-3.5 max-w-[420px] text-[15px] leading-snug">
            Import a statement, confirm a few categories, and Track a Loonie keeps the rest of the
            month honest.
          </p>
        </div>
        <div className="text-ink/60 text-[12.5px]">
          Your data stays in your account. No bank credentials are stored.
        </div>
      </div>
      <div className="flex items-center justify-center p-14">
        <div className="w-full max-w-[360px] animate-[fade-up_0.3s_ease-out]">
          <h2 className="font-display text-2xl font-semibold tracking-[-0.02em]">
            Create your account
          </h2>
          <p className="text-ink-muted mt-2 mb-6.5 text-[13.5px]">Free — takes a minute.</p>
          <SignUpForm />
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
            Already have an account?{' '}
            <Link href="/login" className="text-iris font-medium">
              Sign in
            </Link>
          </p>
        </div>
      </div>
    </>
  );
};

export default SignUpPage;
