import Link from 'next/link';
import { redirect } from 'next/navigation';
import { CheckCircle2 } from 'lucide-react';
import { getServerAuthSession } from '@/lib/auth/session';
import { getCheckoutResult } from '@/lib/services/billing';
import { ServiceValidationError } from '@/lib/services/common';

export const dynamic = 'force-dynamic';

/** Stripe's `return_url` after the embedded form is submitted. */
const UpgradeCompletePage = async ({
  searchParams,
}: {
  searchParams: Promise<{ session_id?: string }>;
}): Promise<React.ReactElement> => {
  const { session_id: sessionId } = await searchParams;
  const session = await getServerAuthSession();
  if (!session?.user) redirect('/login');
  if (!sessionId) redirect('/upgrade');

  let status: 'complete' | 'open' | 'expired';
  try {
    ({ status } = await getCheckoutResult(session.user.id, sessionId));
  } catch (error) {
    if (!(error instanceof ServiceValidationError)) throw error;
    redirect('/upgrade');
  }
  // still open = payment didn't go through (declined, closed 3-D Secure): try again
  if (status !== 'complete') redirect('/upgrade');

  return (
    <div className="flex max-w-[520px] animate-[fade-up_0.3s_ease-out] flex-col items-start">
      <CheckCircle2 size={40} className="text-iris" aria-hidden />
      <h1 className="font-display text-ink mt-4 text-[32px] font-semibold tracking-[-0.025em]">
        You&rsquo;re on Plus
      </h1>
      <p className="text-ink-muted mt-3 text-sm">
        Thanks for supporting Track a Loonie. Every account, all of your history and the Plus
        features are unlocked now. A receipt is on its way to your inbox.
      </p>
      <Link
        href="/dashboard"
        className="bg-iris text-paper-raised mt-6 inline-flex items-center justify-center rounded-full px-4 py-2 text-sm font-medium hover:opacity-90"
      >
        Go to your dashboard
      </Link>
    </div>
  );
};

export default UpgradeCompletePage;
