'use client';

import { useRef, useState } from 'react';
import { Check, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input, Label, Select } from '@/components/ui/field';
import { ReimbursementPanel } from '@/components/transactions/reimbursement-panel';
import { useTransactionForm } from '@/lib/transactions/use-transaction-form';
import { spreadPreview } from '@/lib/transactions/spread-preview';
import { SPREAD_MAX_MONTHS, SPREAD_MIN_MONTHS } from '@/lib/spread';
import { cn } from '@/lib/cn';
import type { FrontendAccount } from '@/lib/services/accounts';
import type { FrontendCategory } from '@/lib/services/categories';
import type { FrontendTransaction } from '@/lib/services/transactions';

const todayIso = (): string => new Date().toISOString().slice(0, 10);

export const TransactionForm = ({
  transaction,
  accounts,
  categories,
  onDone,
}: {
  transaction?: FrontendTransaction;
  accounts: FrontendAccount[];
  categories: FrontendCategory[];
  onDone: () => void;
}): React.ReactElement => {
  const {
    categoryId,
    setCategoryId,
    suggested,
    setSuggested,
    type,
    setType,
    accountId,
    setAccountId,
    isPayment,
    setIsPayment,
    isTransfer,
    setIsTransfer,
    canBePayment,
    isReimbursable,
    setIsReimbursable,
    reimbursementExpectedAmount,
    setReimbursementExpectedAmount,
    canBeReimbursable,
    isSpread,
    setIsSpread,
    spreadStartMonth,
    setSpreadStartMonth,
    spreadMonths,
    setSpreadMonths,
    canBeSpread,
    pending,
    error,
    suggestFor,
    submit,
  } = useTransactionForm({ transaction, accounts });

  const formRef = useRef<HTMLFormElement>(null);
  const [spreadError, setSpreadError] = useState<string | null>(null);

  const [amountValue, setAmountValue] = useState(transaction?.amount ?? '');
  const [expectedAmountError, setExpectedAmountError] = useState<string | null>(null);
  // kept in sync by the reimbursement panel, since links can change without saving the form
  const [linkedTotal, setLinkedTotal] = useState(transaction?.reimbursementLinkedTotal ?? '0');
  const hasReimbursementLinks = Number(linkedTotal) > 0;
  const preview = isSpread ? spreadPreview(amountValue, spreadStartMonth, spreadMonths) : null;

  const toggleSpread = (checked: boolean): void => {
    setSpreadError(null);
    // default the window to the transaction's own month the first time
    if (checked && !spreadStartMonth) {
      const date = String(new FormData(formRef.current ?? undefined).get('date') ?? '');
      setSpreadStartMonth(date.slice(0, 7));
    }
    setIsSpread(checked);
  };

  // Thin FormData → values adapter; all the logic lives in the shared hook so
  // the mobile keypad screen can't drift from it.
  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setExpectedAmountError(null);
    setSpreadError(null);
    const form = new FormData(event.currentTarget);
    const amount = String(form.get('amount') ?? '');

    if (canBeReimbursable && isReimbursable) {
      const expected = Number(reimbursementExpectedAmount);
      if (!reimbursementExpectedAmount || Number.isNaN(expected) || expected <= 0) {
        setExpectedAmountError('Expected amount is required');
        return;
      }
      if (expected > Number(amount)) {
        setExpectedAmountError('Cannot exceed the expense amount');
        return;
      }
    }

    if (canBeSpread && isSpread && !isReimbursable && !preview) {
      setSpreadError(`Pick a start month and ${SPREAD_MIN_MONTHS} to ${SPREAD_MAX_MONTHS} months`);
      return;
    }

    const ok = await submit({
      accountId: String(form.get('accountId') ?? ''),
      amount,
      date: String(form.get('date') ?? ''),
      payee: String(form.get('payee') ?? '') || undefined,
      note: String(form.get('note') ?? '') || undefined,
    });
    if (ok) onDone();
  };

  return (
    <form ref={formRef} onSubmit={handleSubmit} className="flex flex-col gap-4">
      <div className="border-line flex items-baseline gap-2 border-b pb-3.5">
        <span className="text-ink-muted font-mono text-[26px]">$</span>
        <Input
          id="amount"
          name="amount"
          type="number"
          step="0.01"
          min="0.01"
          placeholder="0.00"
          defaultValue={transaction?.amount}
          onChange={(e) => setAmountValue(e.target.value)}
          required
          className="placeholder:text-ink-muted/50 border-0 bg-transparent p-0 font-mono text-[30px] tracking-[-0.03em] tabular-nums shadow-none outline-none focus:border-0"
        />
        <div className="flex shrink-0 gap-1.5">
          <button
            type="button"
            onClick={() => setType('EXPENSE')}
            className={cn(
              'rounded-full px-3 py-1.5 text-[12.5px] font-semibold',
              type === 'EXPENSE'
                ? 'bg-iris text-paper-raised'
                : 'border-line text-ink-muted border',
            )}
          >
            Spend
          </button>
          <button
            type="button"
            onClick={() => setType('INCOME')}
            className={cn(
              'rounded-full px-3 py-1.5 text-[12.5px] font-semibold',
              type === 'INCOME' ? 'bg-iris text-paper-raised' : 'border-line text-ink-muted border',
            )}
          >
            Income
          </button>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label htmlFor="date">Date</Label>
          <Input
            id="date"
            name="date"
            type="date"
            defaultValue={transaction?.date?.slice(0, 10) ?? todayIso()}
            required
          />
        </div>
        <div>
          <Label htmlFor="accountId">Account</Label>
          <Select
            id="accountId"
            name="accountId"
            value={accountId}
            onChange={(e) => setAccountId(e.target.value)}
            required
          >
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </Select>
        </div>
      </div>
      {canBePayment && (
        <label className="text-ink flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={isPayment}
            onChange={(e) => setIsPayment(e.target.checked)}
            className="accent-iris h-4 w-4"
          />
          This is a payment toward the card&apos;s balance
          <span className="text-ink-muted text-xs">(excluded from the statement total)</span>
        </label>
      )}
      <label className="text-ink flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={isTransfer}
          onChange={(e) => setIsTransfer(e.target.checked)}
          className="accent-iris h-4 w-4"
        />
        This is a transfer between my own accounts
        <span className="text-ink-muted text-xs">(excluded from income and spending)</span>
      </label>
      {canBeReimbursable && (
        <div>
          <label className="text-ink flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={isReimbursable}
              disabled={hasReimbursementLinks || isSpread}
              onChange={(e) => setIsReimbursable(e.target.checked)}
              className="accent-iris h-4 w-4"
            />
            This expense will be paid back to me
            <span className="text-ink-muted text-xs">(excluded income when repaid)</span>
          </label>
          {hasReimbursementLinks && (
            <p className="text-ink-muted mt-1 pl-6 text-xs">
              Remove all links below to unmark this expense as reimbursable.
            </p>
          )}
          {isSpread && !isReimbursable && (
            <p className="text-ink-muted mt-1 pl-6 text-xs">
              A spread expense can&apos;t also be reimbursable.
            </p>
          )}
          {isReimbursable && (
            <div className="mt-2 pl-6">
              <Label htmlFor="reimbursementExpectedAmount">Expected reimbursement</Label>
              <Input
                id="reimbursementExpectedAmount"
                name="reimbursementExpectedAmount"
                type="number"
                step="0.01"
                min="0.01"
                max={amountValue || undefined}
                value={reimbursementExpectedAmount}
                onChange={(e) => setReimbursementExpectedAmount(e.target.value)}
                required
              />
              {expectedAmountError && (
                <p className="text-rose mt-1 text-xs" role="alert">
                  {expectedAmountError}
                </p>
              )}
            </div>
          )}
          {transaction && isReimbursable && (
            <div className="mt-3">
              <ReimbursementPanel
                transaction={transaction}
                expectedAmount={reimbursementExpectedAmount}
                onLinkedTotalChange={setLinkedTotal}
              />
            </div>
          )}
        </div>
      )}
      {canBeSpread && (
        <div>
          <label className="text-ink flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={isSpread}
              disabled={isReimbursable}
              onChange={(e) => toggleSpread(e.target.checked)}
              className="accent-iris h-4 w-4"
            />
            Spread this cost over several months
            <span className="text-ink-muted text-xs">(budgets and reports only)</span>
          </label>
          {isReimbursable && (
            <p className="text-ink-muted mt-1 pl-6 text-xs">
              A reimbursable expense can&apos;t also be spread.
            </p>
          )}
          {isSpread && !isReimbursable && (
            <div className="mt-2 pl-6">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label htmlFor="spreadStartMonth">Starting</Label>
                  <Input
                    id="spreadStartMonth"
                    name="spreadStartMonth"
                    type="month"
                    value={spreadStartMonth}
                    onChange={(e) => setSpreadStartMonth(e.target.value)}
                    required
                  />
                </div>
                <div>
                  <Label htmlFor="spreadMonths">Months</Label>
                  <Input
                    id="spreadMonths"
                    name="spreadMonths"
                    type="number"
                    step="1"
                    min={SPREAD_MIN_MONTHS}
                    max={SPREAD_MAX_MONTHS}
                    value={spreadMonths}
                    onChange={(e) => setSpreadMonths(e.target.value)}
                    required
                  />
                </div>
              </div>
              {preview && (
                <p className="text-ink-muted mt-1.5 text-xs" data-testid="spread-preview">
                  {preview}
                </p>
              )}
              {spreadError && (
                <p className="text-rose mt-1 text-xs" role="alert">
                  {spreadError}
                </p>
              )}
            </div>
          )}
        </div>
      )}
      <div>
        <Label htmlFor="payee">Payee</Label>
        <Input
          id="payee"
          name="payee"
          defaultValue={transaction?.payee ?? ''}
          onChange={(e) => suggestFor(e.target.value, '')}
        />
      </div>
      <div>
        <Label htmlFor="note">Note</Label>
        <Input
          id="note"
          name="note"
          defaultValue={transaction?.note ?? ''}
          onChange={(e) => suggestFor('', e.target.value)}
        />
      </div>
      <div>
        <Label htmlFor="categoryId">
          Category{suggested && <span className="text-iris ml-1">(suggested)</span>}
        </Label>
        <div id="categoryId" className="flex flex-wrap gap-1.5">
          {categories.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => {
                setCategoryId(c.id === categoryId ? '' : c.id);
                setSuggested(false);
              }}
              className={cn(
                'rounded-full px-3.5 py-2 text-[13px] font-medium',
                c.id === categoryId
                  ? 'bg-iris text-paper-raised'
                  : 'border-line text-ink-muted border',
              )}
            >
              {c.name}
            </button>
          ))}
        </div>
      </div>
      {error && (
        <p className="bg-rose-soft text-rose rounded-lg px-3 py-2 text-sm" role="alert">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <Button type="submit" icon={Check} loading={pending} className="flex-1 py-3 text-[15px]">
          {transaction ? 'Save changes' : 'Save transaction'}
        </Button>
        <Button
          type="button"
          variant="secondary"
          onClick={onDone}
          icon={X}
          className="px-4.5 py-3 text-[15px]"
        >
          Cancel
        </Button>
      </div>
    </form>
  );
};
