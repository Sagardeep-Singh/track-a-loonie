import Link from 'next/link';
import { Sparkles } from 'lucide-react';
import { cn } from '@/lib/cn';

/** Points at the in-app checkout. Plain link, so it works in server and client trees. */
export const UpgradeLink = ({
  className,
  children = 'Upgrade to Plus',
}: {
  className?: string;
  children?: React.ReactNode;
}): React.ReactElement => (
  <Link
    href="/upgrade"
    className={cn(
      'bg-iris text-paper-raised focus-visible:outline-iris inline-flex items-center justify-center gap-2 rounded-full px-4 py-2 text-sm font-medium hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2',
      className,
    )}
  >
    <Sparkles size={16} aria-hidden />
    {children}
  </Link>
);

/**
 * Shown in place of (or next to) something the user's plan doesn't include.
 * `compact` is the inline one-liner for forms and cards.
 */
export const UpgradePrompt = ({
  title,
  description,
  compact = false,
  className,
}: {
  title: string;
  description?: string;
  compact?: boolean;
  className?: string;
}): React.ReactElement =>
  compact ? (
    <p
      role="status"
      className={cn('bg-paper-sunk text-ink-muted rounded-lg px-3 py-2 text-sm', className)}
    >
      {title}{' '}
      <Link href="/upgrade" className="text-iris font-medium underline-offset-2 hover:underline">
        Upgrade to Plus
      </Link>
    </p>
  ) : (
    <div
      role="status"
      className={cn(
        'border-line bg-paper-raised flex flex-col items-start gap-3 rounded-2xl border p-6',
        className,
      )}
    >
      <h2 className="text-ink text-base font-semibold">{title}</h2>
      {description && <p className="text-ink-muted text-sm">{description}</p>}
      <UpgradeLink />
    </div>
  );
