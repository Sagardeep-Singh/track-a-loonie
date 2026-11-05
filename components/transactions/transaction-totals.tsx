import { Money } from '@/components/ui/money';
import { cn } from '@/lib/cn';
import type { TotalsInclusion, TransactionSummary } from '@/lib/transactions/transaction-summary';

const Stat = ({
  label,
  children,
  className,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}): React.ReactElement => (
  <div className={cn('flex min-w-0 flex-col gap-1 px-2.5 first:pl-0 last:pr-0 lg:px-6', className)}>
    <dt className="text-ink-muted text-[10.5px] font-semibold tracking-[0.06em] uppercase lg:text-[11px]">
      {label}
    </dt>
    <dd className="text-sm break-all lg:text-lg">{children}</dd>
  </div>
);

/** Period totals for the transactions list. Credit/Debit/Net sit in their own
 * columns so they read at a glance. Card payments and transfers get toggles to
 * include/exclude them. Reimbursement income never counts as credit: by
 * default it comes off Debit, and with the expense-month setting it's listed
 * on its own, quieter line instead. */
export const TransactionTotals = ({
  summary,
  inclusion,
  onInclusionChange,
  className,
}: {
  summary: TransactionSummary;
  inclusion: TotalsInclusion;
  onInclusionChange: (inclusion: TotalsInclusion) => void;
  className?: string;
}): React.ReactElement => {
  const toggles = (
    [
      { key: 'payments', label: 'Payments', value: summary.payments },
      { key: 'transfers', label: 'Transfers', value: summary.transfers },
    ] as const
  ).filter((item) => item.value > 0);
  const excluded = summary.reimbursementIncome > 0;

  return (
    <section
      data-testid="transaction-totals"
      aria-label="Transaction totals"
      className={cn(
        'border-line bg-paper-raised rounded-[14px] border px-4 py-3.5 lg:px-6 lg:py-4',
        className,
      )}
    >
      <p className="text-ink-muted text-[12.5px] font-medium">
        {summary.count} transaction{summary.count === 1 ? '' : 's'}
      </p>
      <dl className="divide-line mt-2.5 grid grid-cols-3 divide-x">
        <Stat label="Credit">
          <Money value={summary.credit} tone="income" />
        </Stat>
        <Stat label="Debit">
          <Money value={summary.debit} tone="expense" />
        </Stat>
        <Stat label="Net">
          <Money
            value={summary.net}
            tone={summary.net >= 0 ? 'income' : 'expense'}
            className="font-semibold"
          />
        </Stat>
      </dl>
      {(toggles.length > 0 || excluded) && (
        <div className="border-line text-ink-muted mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 border-t pt-2.5 text-xs">
          {toggles.length > 0 && (
            <div role="group" aria-label="Include in totals" className="flex flex-wrap gap-1.5">
              {toggles.map((item) => {
                const on = inclusion[item.key];
                return (
                  <button
                    key={item.key}
                    type="button"
                    aria-pressed={on}
                    title={
                      on
                        ? `Exclude ${item.label.toLowerCase()}`
                        : `Include ${item.label.toLowerCase()}`
                    }
                    onClick={() => onInclusionChange({ ...inclusion, [item.key]: !on })}
                    className={cn(
                      'flex items-baseline gap-1.5 rounded-full border px-2.5 py-1 transition-colors',
                      on
                        ? 'border-iris bg-paper text-ink'
                        : 'border-line text-ink-muted hover:text-ink line-through decoration-1',
                    )}
                  >
                    {item.label}
                    <Money value={item.value} tone="neutral" className="text-inherit" />
                  </button>
                );
              })}
            </div>
          )}
          {excluded && (
            <span className="flex items-baseline gap-1.5">
              Not in totals: Reimbursements
              <Money
                value={summary.reimbursementIncome}
                tone="neutral"
                className="text-ink-muted"
              />
            </span>
          )}
        </div>
      )}
    </section>
  );
};
