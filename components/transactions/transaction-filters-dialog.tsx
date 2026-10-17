'use client';

import { useState } from 'react';
import { Modal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/field';
import { MoneyInput } from '@/components/ui/money-input';
import { MultiSelect } from '@/components/ui/multi-select';
import type { FrontendAccount } from '@/lib/services/accounts';
import type { FrontendCategory } from '@/lib/services/categories';
import {
  DEFAULT_TRANSACTION_FILTERS,
  type TransactionFilters,
} from '@/lib/transactions/transaction-filters';

const checkboxRow = 'text-ink flex items-center gap-2 text-sm';
const checkboxInput = 'accent-iris h-4 w-4 shrink-0';

export const TransactionFiltersDialog = ({
  open,
  onClose,
  filters,
  onApply,
  accounts,
  categories,
}: {
  open: boolean;
  onClose: () => void;
  filters: TransactionFilters;
  onApply: (next: TransactionFilters) => void;
  accounts: FrontendAccount[];
  categories: FrontendCategory[];
}): React.ReactElement => {
  // A local draft, not the parent's filters directly: closing without
  // "Apply" (Escape, backdrop, the X button) must discard edits, and the
  // parent's filters shouldn't flicker on every keystroke inside the dialog.
  // Seeded once from `filters` — the caller must remount this component
  // (e.g. `key={filtersDialogKey}`, incremented on every open) so a second
  // open re-seeds from whatever is actually active rather than a stale or
  // cancelled draft, mirroring this file's existing `dialogKey`/`drawerKey`
  // convention in `transactions-view.tsx` instead of an effect.
  const [draft, setDraft] = useState<TransactionFilters>(filters);
  // One picker open at a time keeps the dialog's height bounded.
  const [openPicker, setOpenPicker] = useState<'accounts' | 'categories' | null>(null);

  const handleClose = (): void => {
    setDraft(filters);
    onClose();
  };

  const handleApply = (): void => {
    onApply(draft);
    onClose();
  };

  // The period lives in the page's selector, not here, so Reset leaves it be.
  const handleReset = (): void => {
    setDraft({ ...DEFAULT_TRANSACTION_FILTERS, from: filters.from, to: filters.to });
  };

  return (
    <Modal open={open} onClose={handleClose} title="Filters" className="max-w-lg">
      <div className="flex flex-col gap-5">
        {accounts.length > 0 && (
          <MultiSelect
            id="filter-accounts"
            label="Accounts"
            options={accounts}
            selectedIds={draft.accountIds}
            onChange={(accountIds) => setDraft({ ...draft, accountIds })}
            allLabel="All accounts"
            searchPlaceholder="Search accounts"
            open={openPicker === 'accounts'}
            onOpenChange={(open) => setOpenPicker(open ? 'accounts' : null)}
          />
        )}

        {categories.length > 0 && (
          <MultiSelect
            id="filter-categories"
            label="Categories"
            options={categories}
            selectedIds={draft.categoryIds}
            onChange={(categoryIds) => setDraft({ ...draft, categoryIds })}
            allLabel="All categories"
            searchPlaceholder="Search categories"
            open={openPicker === 'categories'}
            onOpenChange={(open) => setOpenPicker(open ? 'categories' : null)}
          />
        )}

        <div>
          <Label htmlFor="filter-type">Type</Label>
          <div id="filter-type" className="flex gap-2">
            {(
              [
                [null, 'All'],
                ['EXPENSE', 'Spending'],
                ['INCOME', 'Income'],
              ] as [TransactionFilters['type'], string][]
            ).map(([value, label]) => (
              <button
                key={label}
                type="button"
                onClick={() => setDraft({ ...draft, type: value })}
                className={`rounded-full border px-3.5 py-1.5 text-[13px] font-medium ${
                  draft.type === value
                    ? 'bg-ink text-paper-raised border-ink'
                    : 'border-line text-ink bg-paper-raised'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <div>
          <Label htmlFor="filter-amount-min">Amount range</Label>
          <div className="flex items-center gap-2">
            <MoneyInput
              id="filter-amount-min"
              placeholder="Min"
              value={draft.amountMin ?? ''}
              onValueChange={(v) => setDraft({ ...draft, amountMin: v || null })}
            />
            <span className="text-ink-muted text-xs">to</span>
            <MoneyInput
              id="filter-amount-max"
              placeholder="Max"
              value={draft.amountMax ?? ''}
              onValueChange={(v) => setDraft({ ...draft, amountMax: v || null })}
            />
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          <label className={checkboxRow}>
            <input
              type="checkbox"
              className={checkboxInput}
              checked={draft.hideTransfers}
              onChange={(e) => setDraft({ ...draft, hideTransfers: e.target.checked })}
            />
            Hide transfers
          </label>
          <label className={checkboxRow}>
            <input
              type="checkbox"
              className={checkboxInput}
              checked={draft.hidePayments}
              onChange={(e) => setDraft({ ...draft, hidePayments: e.target.checked })}
            />
            Hide card payments
          </label>
          <label className={checkboxRow}>
            <input
              type="checkbox"
              className={checkboxInput}
              checked={draft.uncategorizedOnly}
              onChange={(e) => setDraft({ ...draft, uncategorizedOnly: e.target.checked })}
            />
            Uncategorized only
          </label>
          <label className={checkboxRow}>
            <input
              type="checkbox"
              className={checkboxInput}
              checked={draft.pendingReimbursementsOnly}
              onChange={(e) => setDraft({ ...draft, pendingReimbursementsOnly: e.target.checked })}
            />
            Pending reimbursements only
          </label>
        </div>

        <div className="mt-1 flex items-center justify-between gap-3">
          <Button type="button" variant="ghost" onClick={handleReset}>
            Reset
          </Button>
          <Button type="button" onClick={handleApply}>
            Apply
          </Button>
        </div>
      </div>
    </Modal>
  );
};
