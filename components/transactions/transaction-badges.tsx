import { ArrowLeftRight, CreditCard, HandCoins, Undo2, type LucideIcon } from 'lucide-react';
import { Money } from '@/components/ui/money';
import { cn } from '@/lib/cn';
import type { FrontendTransaction } from '@/lib/services/transactions';

type BadgeTransaction = Pick<
  FrontendTransaction,
  | 'isPayment'
  | 'isTransfer'
  | 'isReimbursable'
  | 'isReimbursementIncome'
  | 'reimbursementStatus'
  | 'reimbursementOutstanding'
>;

const Badge = ({
  icon: Icon,
  className,
  children,
}: {
  icon: LucideIcon;
  className: string;
  children: React.ReactNode;
}): React.ReactElement => (
  <span
    data-testid="transaction-badge"
    className={cn(
      'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium',
      className,
    )}
  >
    <Icon size={11} aria-hidden="true" />
    {children}
  </span>
);

/** Small labels for transactions that count differently from plain spending
 * or income: reimbursements, card payments, transfers, and reimbursable
 * expenses (with what's still owed). Renders nothing for an ordinary row. */
export const TransactionBadges = ({
  transaction: t,
  className,
}: {
  transaction: BadgeTransaction;
  className?: string;
}): React.ReactElement | null => {
  const badges: React.ReactElement[] = [];
  if (t.isReimbursementIncome) {
    badges.push(
      <Badge key="reimbursement" icon={Undo2} className="bg-sky-soft text-sky">
        Reimbursement
      </Badge>,
    );
  }
  // a card payment is also flagged as a transfer once matched; one label is enough
  if (t.isPayment) {
    badges.push(
      <Badge key="payment" icon={CreditCard} className="bg-iris-soft text-iris">
        Payment
      </Badge>,
    );
  } else if (t.isTransfer) {
    badges.push(
      <Badge key="transfer" icon={ArrowLeftRight} className="bg-paper-sunk text-ink-muted">
        Transfer
      </Badge>,
    );
  }
  if (t.isReimbursable) {
    badges.push(
      <Badge key="reimbursable" icon={HandCoins} className="bg-rose-soft text-rose">
        {t.reimbursementStatus === 'COMPLETE' ? (
          'Reimbursable · reimbursed'
        ) : (
          <>
            Reimbursable ·{' '}
            <Money value={t.reimbursementOutstanding} tone="neutral" className="text-[11px]" />{' '}
            pending
          </>
        )}
      </Badge>,
    );
  }
  if (badges.length === 0) return null;
  return <div className={cn('flex flex-wrap items-center gap-1.5', className)}>{badges}</div>;
};
