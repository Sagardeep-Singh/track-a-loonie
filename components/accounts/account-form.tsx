'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Check, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input, Label, Select } from '@/components/ui/field';
import { patchJSON, postJSON } from '@/lib/api-client';
import type { FrontendAccount } from '@/lib/services/accounts';

const ACCOUNT_TYPES = [
  { value: 'CHECKING', label: 'Checking' },
  { value: 'SAVINGS', label: 'Savings' },
  { value: 'CREDIT_CARD', label: 'Credit card' },
  { value: 'CASH', label: 'Cash' },
] as const;

export const AccountForm = ({
  account,
  onDone,
  zeroBased = false,
}: {
  account?: FrontendAccount;
  onDone: () => void;
  /** show the on-budget toggle; it only means something in zero-based mode */
  zeroBased?: boolean;
}): React.ReactElement => {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [type, setType] = useState(account?.type ?? 'CHECKING');
  // a new account follows its type's default (savings off-budget) until the
  // user ticks the box themselves
  const [onBudgetChoice, setOnBudgetChoice] = useState<boolean | null>(account?.onBudget ?? null);
  const onBudget = onBudgetChoice ?? type !== 'SAVINGS';

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setPending(true);
    setError(null);

    const form = new FormData(event.currentTarget);
    const body = {
      name: form.get('name'),
      type: form.get('type'),
      startingBalance: form.get('startingBalance'),
      statementDay: type === 'CREDIT_CARD' ? form.get('statementDay') || null : null,
      ...(zeroBased ? { onBudget } : {}),
    };

    const res = account
      ? await patchJSON(`/api/accounts/${account.id}`, body)
      : await postJSON('/api/accounts', body);

    setPending(false);
    if (!res.ok) {
      setError('Could not save this account. Check the fields and try again.');
      return;
    }

    router.refresh();
    onDone();
  };

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <div>
        <Label htmlFor="name">Name</Label>
        <Input id="name" name="name" defaultValue={account?.name} required autoFocus />
      </div>
      <div>
        <Label htmlFor="type">Type</Label>
        <Select id="type" name="type" value={type} onChange={(e) => setType(e.target.value)}>
          {ACCOUNT_TYPES.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </Select>
      </div>
      <div>
        <Label htmlFor="startingBalance">Starting balance</Label>
        <Input
          id="startingBalance"
          name="startingBalance"
          type="number"
          step="0.01"
          defaultValue={account?.startingBalance ?? '0'}
        />
      </div>
      {type === 'CREDIT_CARD' && (
        <div>
          <Label htmlFor="statementDay">Statement closes on (day of month)</Label>
          <Input
            id="statementDay"
            name="statementDay"
            type="number"
            min={1}
            max={28}
            defaultValue={account?.statementDay ?? ''}
            placeholder="e.g. 15"
          />
          <p className="text-ink-muted mt-1 text-xs">
            1–28, to stay valid across every month. Lets you view transactions by statement period
            instead of calendar month.
          </p>
        </div>
      )}
      {zeroBased && (
        <label className="flex items-start gap-3 text-sm">
          <input
            type="checkbox"
            name="onBudget"
            className="accent-iris mt-0.5 size-4"
            checked={onBudget}
            onChange={(e) => setOnBudgetChoice(e.target.checked)}
          />
          <span>
            On-budget
            <span className="text-ink-muted mt-0.5 block text-xs">
              Its balance counts toward Ready to Assign. Turn off for long-term savings you
              don&rsquo;t want to budget.
            </span>
          </span>
        </label>
      )}
      {error && (
        <p className="bg-rose-soft text-rose rounded-lg px-3 py-2 text-sm" role="alert">
          {error}
        </p>
      )}
      <Button type="submit" icon={account ? Check : Plus} loading={pending}>
        {account ? 'Save changes' : 'Add account'}
      </Button>
    </form>
  );
};
