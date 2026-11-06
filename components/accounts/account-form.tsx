'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Check, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input, Label, Select } from '@/components/ui/field';
import { MoneyInput } from '@/components/ui/money-input';
import {
  ACCOUNT_TYPE_GROUPS,
  ACCOUNT_TYPES,
  accountTypesInGroup,
  defaultOnBudgetFor,
  defaultTracksBalanceFor,
} from '@/lib/account-types';
import { patchJSON, postJSON } from '@/lib/api-client';
import { todayDateKey } from '@/lib/date';
import type { FrontendAccount } from '@/lib/services/accounts';

export const AccountForm = ({
  account,
  onDone,
  zeroBased = false,
}: {
  account?: FrontendAccount;
  onDone: () => void;
  /** words the on-budget toggle for zero-based budgeting instead of savings goals */
  zeroBased?: boolean;
}): React.ReactElement => {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [type, setType] = useState(account?.type ?? 'CHECKING');
  // a new account follows its type's default (savings and investments
  // off-budget) until the user ticks the box themselves
  const [onBudgetChoice, setOnBudgetChoice] = useState<boolean | null>(account?.onBudget ?? null);
  // same idea for balance tracking: savings, registered and investment
  // accounts default to it
  const [tracksChoice, setTracksChoice] = useState<boolean | null>(account?.tracksBalance ?? null);
  const tracksBalance = tracksChoice ?? defaultTracksBalanceFor(type);
  // a tracked balance moves without transactions, so it's never on-budget
  const onBudget = !tracksBalance && (onBudgetChoice ?? defaultOnBudgetFor(type));
  // an account with transactions has to lose them before it can be tracked
  const canTrack = account?.tracksBalance || !account?.transactionCount;
  // while tracked, an existing account's balance comes from its updates
  const showStartingBalance = !(account?.tracksBalance && tracksBalance);

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setPending(true);
    setError(null);

    const form = new FormData(event.currentTarget);
    const body = {
      name: form.get('name'),
      type: form.get('type'),
      ...(showStartingBalance && { startingBalance: form.get('startingBalance') }),
      statementDay: type === 'CREDIT_CARD' ? form.get('statementDay') || null : null,
      onBudget,
      tracksBalance,
      startingBalanceDate: todayDateKey(),
    };

    const res = account
      ? await patchJSON(`/api/accounts/${account.id}`, body)
      : await postJSON('/api/accounts', body);

    setPending(false);
    if (!res.ok) {
      setError(res.error ?? 'Could not save this account. Check the fields and try again.');
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
          {ACCOUNT_TYPE_GROUPS.map((group) => (
            <optgroup key={group} label={group}>
              {accountTypesInGroup(group).map((value) => (
                <option key={value} value={value}>
                  {ACCOUNT_TYPES[value].label}
                </option>
              ))}
            </optgroup>
          ))}
        </Select>
      </div>
      {showStartingBalance && (
        <div>
          <Label htmlFor="startingBalance">
            {!account && tracksBalance ? 'Current balance' : 'Starting balance'}
          </Label>
          <MoneyInput
            id="startingBalance"
            name="startingBalance"
            // turning tracking off starts the transaction math from today's balance
            defaultValue={
              account?.tracksBalance ? account.balance : (account?.startingBalance ?? '0')
            }
          />
        </div>
      )}
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
      <label className="flex items-start gap-3 text-sm">
        <input
          type="checkbox"
          name="tracksBalance"
          className="accent-iris mt-0.5 size-4"
          checked={tracksBalance}
          disabled={!canTrack}
          onChange={(e) => setTracksChoice(e.target.checked)}
        />
        <span>
          Track by balance updates
          <span className="text-ink-muted mt-0.5 block text-xs">
            {canTrack
              ? 'For savings, registered and investment accounts. Log the balance whenever you check it instead of logging transactions.'
              : 'Move or delete this account’s transactions first. A balance-tracked account doesn’t hold transactions.'}
          </span>
        </span>
      </label>
      {!tracksBalance && (
        <label className="flex items-start gap-3 text-sm">
          <input
            type="checkbox"
            name="onBudget"
            className="accent-iris mt-0.5 size-4"
            checked={onBudget}
            onChange={(e) => setOnBudgetChoice(e.target.checked)}
          />
          <span>
            {zeroBased ? 'On-budget' : 'Spending account'}
            <span className="text-ink-muted mt-0.5 block text-xs">
              {zeroBased
                ? 'Its balance counts toward Ready to Assign. Turn off for long-term savings you don’t want to budget.'
                : 'Money you spend from day to day. Transfers out of it tagged with a savings goal’s category count toward the goal. Turn off for savings accounts.'}
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
