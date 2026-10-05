import type { Metadata } from 'next';
import Link from 'next/link';
import { AuthAside } from '@/components/auth/auth-aside';
import { ResetPasswordForm } from '@/components/auth/reset-password-form';
import { getPasswordResetTokenStatus } from '@/lib/services/passwordReset';

// The token is in this page's URL; don't hand it to any other origin.
export const metadata: Metadata = { referrer: 'no-referrer' };

const STATUS_MESSAGES: Record<'invalid' | 'expired', string> = {
  invalid: 'This reset link is invalid or has already been used.',
  expired: 'This reset link has expired.',
};

const ResetPasswordPage = async ({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}): Promise<React.ReactElement> => {
  const { token } = await searchParams;
  const status = token ? await getPasswordResetTokenStatus(token) : 'invalid';

  return (
    <>
      <AuthAside />
      <div className="flex flex-col px-6 py-8 lg:items-center lg:justify-center lg:p-14">
        <div className="w-full lg:max-w-[360px] lg:animate-[fade-up_0.3s_ease-out]">
          <h2 className="font-display text-2xl font-semibold tracking-[-0.02em]">
            Choose a new password
          </h2>
          <p className="text-ink-muted mt-2 mb-6.5 text-[13.5px]">
            You&rsquo;ll sign in with it from now on.
          </p>
          {status === 'valid' && token ? (
            <ResetPasswordForm token={token} />
          ) : (
            <>
              <p className="bg-rose-soft text-rose rounded-lg px-3 py-2 text-sm" role="alert">
                {STATUS_MESSAGES[status === 'expired' ? 'expired' : 'invalid']}
              </p>
              <p className="text-ink-muted mt-4 text-[13.5px]">
                <Link href="/forgot-password" className="text-iris font-medium">
                  Request a new link
                </Link>
              </p>
            </>
          )}
          <p className="text-ink-muted mt-6 text-center text-[13.5px]">
            <Link href="/login" className="text-iris font-medium">
              Back to sign in
            </Link>
          </p>
        </div>
      </div>
    </>
  );
};

export default ResetPasswordPage;
