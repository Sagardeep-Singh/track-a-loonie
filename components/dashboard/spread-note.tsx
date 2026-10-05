import Link from 'next/link';
import { CalendarRange } from 'lucide-react';
import { Money } from '@/components/ui/money';
import { overviewDayHref } from '@/lib/dashboard/drilldown';
import type { OverviewData } from '@/lib/services/overview';

/**
 * Explains spread shares inside the month's spending: the pie and budget
 * drill-downs open Transactions for this month, which lists the real payment
 * only in the month it was paid. Each row links to that payment instead.
 */
export const SpreadNote = ({
  shares,
  total,
}: {
  shares: OverviewData['spreadShares'];
  total: string;
}): React.ReactElement | null => {
  if (shares.length === 0) return null;
  return (
    <div className="border-line mt-4 border-t pt-3.5" data-testid="spread-note">
      <div className="text-ink-muted flex items-center gap-1.5 text-xs">
        <CalendarRange size={12} />
        <span className="flex items-center gap-1">
          Includes <Money value={total} tone="neutral" className="text-xs" /> spread from{' '}
          {shares.length} {shares.length === 1 ? 'payment' : 'payments'}
        </span>
      </div>
      <ul className="mt-2 flex flex-col gap-1">
        {shares.map((s) => (
          <li key={s.transactionId}>
            <Link
              href={overviewDayHref(s.sourceMonth, s.sourceDay, s.transactionId)}
              className="hover:bg-paper flex items-center gap-2 rounded-md py-1 text-[12.5px]"
            >
              <span className="min-w-0 flex-1 truncate">
                {s.payee} <span className="text-ink-muted">· {s.categoryName}</span>
              </span>
              <Money value={s.amount} tone="neutral" className="shrink-0 text-[12.5px]" />
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
};
