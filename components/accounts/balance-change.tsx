import type { BalanceChange as Change } from '@/lib/account-history';
import { cn } from '@/lib/cn';

const money = (value: number): string =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Math.abs(value));

/** "+$1,250.00 (+4.2%) over 1Y" change line under a balance. */
export const BalanceChange = ({
  change,
  rangeLabel,
}: {
  change: Change | null;
  rangeLabel: string;
}): React.ReactElement | null => {
  if (!change) return null;
  const sign = change.amount > 0 ? '+' : change.amount < 0 ? '−' : '';
  return (
    <p className="text-ink-muted text-[12.5px]">
      <span
        className={cn(
          'font-mono tabular-nums',
          change.amount > 0 && 'text-sky',
          change.amount < 0 && 'text-rose',
        )}
      >
        {sign}
        {money(change.amount)}
        {change.percent !== null && ` (${sign}${Math.abs(change.percent).toFixed(1)}%)`}
      </span>{' '}
      over {rangeLabel}
    </p>
  );
};
