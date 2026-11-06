'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input, Label } from '@/components/ui/field';
import { MoneyInput } from '@/components/ui/money-input';
import { balanceFieldLabel, liabilityAwareBalance } from '@/lib/account-types';
import { postJSON } from '@/lib/api-client';
import { todayDateKey } from '@/lib/date';

/** Logs a new balance for a balance-tracked account. */
export const BalanceUpdateForm = ({
  accountId,
  accountType,
  currentBalance,
  onDone,
}: {
  accountId: string;
  /** a liability's balance is typed as the amount owing */
  accountType: string;
  /** prefills the amount, so a small change is a quick edit */
  currentBalance: string;
  onDone?: () => void;
}): React.ReactElement => {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  // bumping the key resets the fields to fresh defaults after a save
  const [formKey, setFormKey] = useState(0);

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setPending(true);
    setError(null);

    const form = new FormData(event.currentTarget);
    const res = await postJSON(`/api/accounts/${accountId}/balance-updates`, {
      balance: liabilityAwareBalance(String(form.get('balance') ?? ''), accountType),
      date: form.get('date'),
      note: form.get('note') || undefined,
    });

    setPending(false);
    if (!res.ok) {
      setError(res.error ?? 'Could not log this balance. Check the fields and try again.');
      return;
    }

    setFormKey((k) => k + 1);
    router.refresh();
    onDone?.();
  };

  const id = (field: string): string => `balance-update-${accountId}-${field}`;

  return (
    <form key={formKey} onSubmit={handleSubmit} className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <Label htmlFor={id('balance')}>{balanceFieldLabel(accountType, 'New')}</Label>
          <MoneyInput
            id={id('balance')}
            name="balance"
            defaultValue={liabilityAwareBalance(currentBalance, accountType)}
            required
          />
        </div>
        <div>
          <Label htmlFor={id('date')}>As of</Label>
          <Input
            id={id('date')}
            name="date"
            type="date"
            defaultValue={todayDateKey()}
            max={todayDateKey()}
            required
          />
        </div>
      </div>
      <div>
        <Label htmlFor={id('note')}>Note (optional)</Label>
        <Input id={id('note')} name="note" maxLength={200} placeholder="e.g. Q3 statement" />
      </div>
      {error && (
        <p className="bg-rose-soft text-rose rounded-lg px-3 py-2 text-sm" role="alert">
          {error}
        </p>
      )}
      <Button type="submit" icon={Plus} loading={pending}>
        Log balance
      </Button>
    </form>
  );
};
