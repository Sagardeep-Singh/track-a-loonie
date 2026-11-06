import Link from 'next/link';
import { HISTORY_RANGES, type HistoryRange } from '@/lib/account-history';
import { cn } from '@/lib/cn';

export const RANGE_LABELS: Record<HistoryRange, string> = { 6: '6M', 12: '1Y', 24: '2Y' };

/** Range switcher for the balance charts; a link per range so the server
 * page re-renders with `?range=` and the choice is shareable. */
export const HistoryRangePills = ({
  basePath,
  range,
}: {
  basePath: string;
  range: HistoryRange;
}): React.ReactElement => (
  <nav aria-label="Chart range" className="flex gap-1">
    {HISTORY_RANGES.map((r) => (
      <Link
        key={r}
        href={`${basePath}?range=${r}`}
        scroll={false}
        aria-current={r === range ? 'page' : undefined}
        className={cn(
          'rounded-full px-3 py-1 text-[12.5px] font-medium',
          r === range ? 'bg-iris-soft text-iris' : 'text-ink-muted hover:text-ink',
        )}
      >
        {RANGE_LABELS[r]}
      </Link>
    ))}
  </nav>
);
