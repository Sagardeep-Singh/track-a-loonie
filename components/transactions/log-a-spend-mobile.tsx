'use client';

import { useEffect, useRef, useState } from 'react';
import { Check, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input, Label, Select } from '@/components/ui/field';
import { NumericKeypad } from '@/components/ui/numeric-keypad';
import { isValidKeypadAmount } from '@/lib/ui/numeric-keypad';
import { isDesktopViewport } from '@/lib/ui/viewport';
import { useTransactionForm } from '@/lib/transactions/use-transaction-form';
import { cn } from '@/lib/cn';
import { todayDateKey } from '@/lib/date';
import type { FrontendAccount } from '@/lib/services/accounts';
import type { FrontendCategory } from '@/lib/services/categories';

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * The mobile "Log a spend" screen: a full-screen shell with a keypad-driven
 * amount, not a narrower `Drawer`. Built on plain `role="dialog"` rather
 * than `Modal`/`Drawer` (neither positions like this), so the focus
 * trap / Escape / scroll-lock behaviour every other overlay in the app has
 * is reproduced here explicitly.
 *
 * Field ids are prefixed `mobile-`: this shell and the desktop `Drawer` are
 * both in the DOM at once (the split is CSS-only), so shared ids would break
 * every `Label htmlFor` association.
 */
export const LogASpendMobile = ({
  accounts,
  categories,
  onDone,
}: {
  accounts: FrontendAccount[];
  categories: FrontendCategory[];
  onDone: () => void;
}): React.ReactElement => {
  const panelRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<Element | null>(null);
  const [amount, setAmount] = useState('');
  const [payee, setPayee] = useState('');
  const [note, setNote] = useState('');
  const [date, setDate] = useState(todayDateKey());

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
    pending,
    error,
    suggestFor,
    submit,
  } = useTransactionForm({ accounts });

  useEffect(() => {
    // This shell is mounted (hidden) alongside the desktop Drawer at lg+, and
    // hidden is not unmounted — skip the global side effects there so the
    // Drawer stays the only overlay touching body scroll and focus.
    if (isDesktopViewport()) return;

    triggerRef.current = document.activeElement;
    document.body.style.overflow = 'hidden';

    const focusable = (): HTMLElement[] =>
      Array.from(panelRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR) ?? []);

    focusable()[0]?.focus();

    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        onDone();
        return;
      }
      if (e.key !== 'Tab') return;

      const elements = focusable();
      if (elements.length === 0) return;
      const first = elements[0];
      const last = elements[elements.length - 1];

      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      // Clear the lock outright rather than restoring a captured value: the
      // hidden desktop `Drawer` mounts alongside this shell and its own
      // cleanup runs in tree order, so restoring a snapshot here would put
      // 'hidden' back after the Drawer had already released it.
      document.body.style.removeProperty('overflow');
      if (triggerRef.current instanceof HTMLElement) {
        triggerRef.current.focus();
      }
    };
  }, [onDone]);

  const valid = isValidKeypadAmount(amount);

  const handleSave = async (): Promise<void> => {
    if (!valid) return;
    const ok = await submit({
      accountId,
      amount,
      date,
      payee: payee || undefined,
      note: note || undefined,
    });
    if (ok) onDone();
  };

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-modal="true"
      aria-label="Log a transaction"
      data-testid="log-a-spend-mobile"
      className="bg-paper fixed inset-0 z-40 flex flex-col"
    >
      <div className="border-line flex shrink-0 items-center justify-between border-b px-5 py-3.5">
        <button
          type="button"
          onClick={onDone}
          aria-label="Close"
          className="text-ink-muted focus-visible:ring-iris flex size-9 items-center justify-center rounded-full focus-visible:ring-2 focus-visible:outline-none"
        >
          <X size={20} />
        </button>
        <span className="text-ink text-[15px] font-semibold">Log a transaction</span>
        <span className="size-9" aria-hidden="true" />
      </div>

      <div className="flex-1 overflow-y-auto px-5 pt-5 pb-6">
        <div className="flex items-baseline justify-center gap-1.5" aria-hidden="true">
          <span className="text-ink-muted font-mono text-2xl">$</span>
          <span className="font-mono text-[56px] leading-none tracking-[-0.03em] tabular-nums">
            {amount || '0'}
          </span>
        </div>
        {/* Screen readers get the settled figure, not one announcement per key. */}
        <span className="sr-only" role="status" aria-live="polite">
          {`Amount: ${amount || '0'} dollars`}
        </span>

        <div className="mt-5 flex justify-center gap-1.5">
          <button
            type="button"
            onClick={() => setType('EXPENSE')}
            className={cn(
              'rounded-full px-4 py-2 text-[13px] font-semibold',
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
              'rounded-full px-4 py-2 text-[13px] font-semibold',
              type === 'INCOME' ? 'bg-iris text-paper-raised' : 'border-line text-ink-muted border',
            )}
          >
            Income
          </button>
        </div>

        <NumericKeypad value={amount} onChange={setAmount} className="mt-5" />

        <div className="mt-5 flex flex-col gap-4">
          <div>
            <Label htmlFor="mobile-payee">Payee</Label>
            <Input
              id="mobile-payee"
              value={payee}
              onChange={(e) => {
                setPayee(e.target.value);
                suggestFor(e.target.value, '');
              }}
            />
          </div>
          <div>
            <Label htmlFor="mobile-date">Date</Label>
            <Input
              id="mobile-date"
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              required
            />
          </div>
          <div>
            <Label htmlFor="mobile-accountId">Account</Label>
            <Select
              id="mobile-accountId"
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
          <div>
            <Label htmlFor="mobile-note">Memo</Label>
            <Input
              id="mobile-note"
              value={note}
              onChange={(e) => {
                setNote(e.target.value);
                suggestFor('', e.target.value);
              }}
            />
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
          </label>
          <div>
            <Label htmlFor="mobile-categoryId">
              Category{suggested && <span className="text-iris ml-1">(suggested)</span>}
            </Label>
            {/* Same chip markup as the mobile Categorize card — one tap selects. */}
            <div id="mobile-categoryId" className="flex flex-wrap gap-2">
              {categories.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => {
                    setCategoryId(c.id === categoryId ? '' : c.id);
                    setSuggested(false);
                  }}
                  className={cn(
                    'rounded-full border px-3.5 py-2 text-[13px] font-medium',
                    c.id === categoryId
                      ? 'border-iris bg-iris text-paper-raised'
                      : 'border-line text-ink',
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
        </div>
      </div>

      <div
        className="border-line bg-paper-raised flex shrink-0 gap-2 border-t px-5 pt-3"
        style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 12px)' }}
      >
        <Button
          type="button"
          variant="secondary"
          onClick={onDone}
          icon={X}
          className="px-4.5 py-3 text-[15px]"
        >
          Cancel
        </Button>
        <Button
          type="button"
          onClick={() => void handleSave()}
          icon={Check}
          loading={pending}
          disabled={!valid}
          className="flex-1 py-3 text-[15px]"
        >
          Save transaction
        </Button>
      </div>
    </div>
  );
};
