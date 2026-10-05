import Link from 'next/link';
import { AuthAside } from '@/components/auth/auth-aside';
import { ForgotPasswordForm } from '@/components/auth/forgot-password-form';
import { isPasswordResetConfigured } from '@/lib/services/passwordReset';

// Every address gets this same confirmation (lib/auth/actions.ts), so the
// copy must never imply whether an account exists.
const SENT_MESSAGE =
  'If that email has an account, a message is on its way with what to do next. The link expires in an hour.';

const ForgotPasswordPage = async ({
  searchParams,
}: {
  searchParams: Promise<{ sent?: string }>;
}): Promise<React.ReactElement> => {
  const { sent } = await searchParams;
  const configured = isPasswordResetConfigured();

  return (
    <>
      <AuthAside />
      <div className="flex flex-col px-6 py-8 lg:items-center lg:justify-center lg:p-14">
        <div className="w-full lg:max-w-[360px] lg:animate-[fade-up_0.3s_ease-out]">
          <h2 className="font-display text-2xl font-semibold tracking-[-0.02em]">
            Forgot your password?
          </h2>
          <p className="text-ink-muted mt-2 mb-6.5 text-[13.5px]">
            Enter your email and we&rsquo;ll send you a link to choose a new one.
          </p>
          {!configured ? (
            <p className="bg-rose-soft text-rose rounded-lg px-3 py-2 text-sm" role="status">
              Password reset by email isn&rsquo;t available on this deployment.
            </p>
          ) : sent === '1' ? (
            <p className="bg-sky-soft text-sky rounded-lg px-3 py-2 text-sm" role="status">
              {SENT_MESSAGE}
            </p>
          ) : (
            <ForgotPasswordForm />
          )}
          <p className="text-ink-muted mt-6 text-center text-[13.5px]">
            Remembered it?{' '}
            <Link href="/login" className="text-iris font-medium">
              Back to sign in
            </Link>
          </p>
        </div>
      </div>
    </>
  );
};

export default ForgotPasswordPage;
