'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Check, CheckCircle2, Loader2, Pencil, Plus, Trash2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { MoneyInput } from '@/components/ui/money-input';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Money } from '@/components/ui/money';
import { ReimbursementLinkPicker } from '@/components/transactions/reimbursement-link-picker';
import { formatDate } from '@/lib/format';
import { deleteJSON, getJSON, patchJSON } from '@/lib/api-client';
import { cn } from '@/lib/cn';
import type { FrontendTransaction } from '@/lib/services/transactions';
import type { FrontendExpenseReimbursement } from '@/lib/services/reimbursements';

const STATUS_LABEL: Record<string, string> = {
  PENDING: 'Pending',
  PARTIAL: 'Partial',
  COMPLETE: 'Complete',
};

const statusClass = (status: string | null): string => {
  if (status === 'COMPLETE') return 'bg-sky-soft text-sky';
  if (status === 'PARTIAL') return 'border-iris/40 bg-iris-soft text-iris';
  return 'border-line text-ink-muted border';
};

/**
 * Every field the /api/transactions/:id PATCH validator needs, unchanged —
 * `isPayment`/`isTransfer`/`isReimbursable` all default to `false` when
 * omitted (per lib/validators/transactions.ts), so a targeted PATCH that
 * sends only the one changed field would silently reset the others. The
 * transaction form already avoids this by always submitting everything; this
 * panel's own writes (mark/unmark fully reimbursed) have to do the same.
 */
const buildFullPatch = (
  transaction: FrontendTransaction,
  overrides: {
    isReimbursable?: boolean;
    reimbursementExpectedAmount?: string;
    reimbursementCompleted?: boolean;
  },
): Record<string, unknown> => ({
  accountId: transaction.accountId,
  categoryId: transaction.categoryId,
  amount: transaction.amount,
  type: transaction.type,
  date: transaction.date,
  payee: transaction.payee ?? undefined,
  note: transaction.note ?? undefined,
  isPayment: transaction.isPayment,
  isTransfer: transaction.isTransfer,
  isReimbursable: transaction.isReimbursable,
  reimbursementExpectedAmount: transaction.reimbursementExpectedAmount ?? undefined,
  ...overrides,
});

const sameAmount = (a: string | null, b: string): boolean =>
  a !== null && Math.round(Number(a) * 100) === Math.round(Number(b) * 100);

export const ReimbursementPanel = ({
  transaction,
  expectedAmount,
  onLinkedTotalChange,
}: {
  transaction: FrontendTransaction;
  /** the form's current (possibly unsaved) expected reimbursement */
  expectedAmount: string;
  onLinkedTotalChange?: (linkedTotal: string) => void;
}): React.ReactElement => {
  const router = useRouter();
  // What the server currently holds for the reimbursable fields. Starts from
  // the saved transaction and moves forward as this panel persists them, so a
  // freshly ticked "will be paid back" box can be linked without saving first.
  const [saved, setSaved] = useState({
    isReimbursable: transaction.isReimbursable,
    expectedAmount: transaction.reimbursementExpectedAmount,
  });
  const [persistPending, setPersistPending] = useState(false);
  const [detail, setDetail] = useState<FrontendExpenseReimbursement | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerKey, setPickerKey] = useState(0);
  const [editingLinkId, setEditingLinkId] = useState<string | null>(null);
  const [editAmountValue, setEditAmountValue] = useState('');
  const [editError, setEditError] = useState<string | null>(null);
  const [editPending, setEditPending] = useState(false);
  const [removeConfirmLinkId, setRemoveConfirmLinkId] = useState<string | null>(null);
  const [removePending, setRemovePending] = useState(false);
  const [completeTogglePending, setCompleteTogglePending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = async (): Promise<void> => {
    setLoadError(null);
    const res = await getJSON<FrontendExpenseReimbursement>(
      `/api/transactions/${transaction.id}/reimbursement`,
    );
    if (!res.ok) {
      setLoadError("Couldn't load reimbursement details.");
      return;
    }
    setDetail(res.data);
    onLinkedTotalChange?.(res.data.linkedTotal);
  };

  useEffect(() => {
    (async () => {
      await load();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transaction.id]);

  const afterChange = async (): Promise<void> => {
    await load();
    router.refresh();
  };

  /**
   * Links and the complete toggle need the expense to be reimbursable on the
   * server, so persist the form's reimbursable flag and expected amount first
   * when they differ from what is saved. Other unsaved form edits are left
   * alone until the user saves the form.
   */
  const ensureReimbursableSaved = async (): Promise<boolean> => {
    const expected = Number(expectedAmount);
    if (!expectedAmount || Number.isNaN(expected) || expected <= 0) {
      setActionError('Enter the expected reimbursement first.');
      return false;
    }
    if (expected > Number(transaction.amount)) {
      setActionError('The expected reimbursement cannot exceed the expense amount.');
      return false;
    }
    if (saved.isReimbursable && sameAmount(saved.expectedAmount, expectedAmount)) return true;

    setPersistPending(true);
    const res = await patchJSON(
      `/api/transactions/${transaction.id}`,
      buildFullPatch(transaction, {
        isReimbursable: true,
        reimbursementExpectedAmount: expectedAmount,
      }),
    );
    setPersistPending(false);
    if (!res.ok) {
      setActionError(res.error ?? 'Could not mark this expense as reimbursable. Try again.');
      return false;
    }
    setSaved({ isReimbursable: true, expectedAmount });
    await afterChange();
    return true;
  };

  const openPicker = async (): Promise<void> => {
    setActionError(null);
    if (!(await ensureReimbursableSaved())) return;
    setPickerKey((k) => k + 1);
    setPickerOpen(true);
  };

  const toggleComplete = async (completed: boolean): Promise<void> => {
    setActionError(null);
    if (!(await ensureReimbursableSaved())) return;
    setCompleteTogglePending(true);
    const res = await patchJSON(
      `/api/transactions/${transaction.id}`,
      buildFullPatch(transaction, {
        isReimbursable: true,
        reimbursementExpectedAmount: expectedAmount,
        reimbursementCompleted: completed,
      }),
    );
    setCompleteTogglePending(false);
    if (!res.ok) {
      setActionError('Could not update this reimbursement. Try again.');
      return;
    }
    await afterChange();
  };

  const startEdit = (linkId: string, currentAmount: string): void => {
    setEditingLinkId(linkId);
    setEditAmountValue(currentAmount);
    setEditError(null);
  };

  const saveEdit = async (linkId: string): Promise<void> => {
    setEditPending(true);
    setEditError(null);
    const res = await patchJSON(`/api/reimbursement-links/${linkId}`, { amount: editAmountValue });
    setEditPending(false);
    if (!res.ok) {
      setEditError(res.error ?? 'Could not update this link.');
      return;
    }
    setEditingLinkId(null);
    await afterChange();
  };

  const removeLink = async (linkId: string): Promise<void> => {
    setRemovePending(true);
    await deleteJSON(`/api/reimbursement-links/${linkId}`);
    setRemovePending(false);
    setRemoveConfirmLinkId(null);
    await afterChange();
  };

  if (loadError) {
    return (
      <div className="border-line bg-paper-sunk rounded-[14px] border p-4">
        <p className="text-rose text-sm" role="alert">
          {loadError}
        </p>
        <Button type="button" variant="ghost" className="mt-2 px-0" onClick={load}>
          Retry
        </Button>
      </div>
    );
  }

  if (!detail) {
    return (
      <div className="border-line bg-paper-sunk flex items-center gap-2 rounded-[14px] border p-4">
        <Loader2 size={14} className="animate-spin" />
        <span className="text-ink-muted text-sm" role="status">
          Loading reimbursement…
        </span>
      </div>
    );
  }

  return (
    <div className="border-line bg-paper-sunk rounded-[14px] border p-4">
      <div className="flex items-center justify-between">
        <span className="text-ink-muted text-[11px] font-semibold tracking-[0.1em] uppercase">
          Reimbursement
        </span>
        <span
          className={cn(
            'rounded-full px-2.5 py-1 text-[11.5px] font-semibold',
            statusClass(detail.status),
          )}
        >
          {STATUS_LABEL[detail.status ?? 'PENDING']}
          {detail.completedManually && detail.status === 'COMPLETE' && ' · manual'}
        </span>
      </div>

      <div className="mt-3 grid grid-cols-3 gap-2 text-center">
        <div>
          <div className="text-ink-muted text-xs">Expected</div>
          <Money value={detail.expectedAmount ?? '0.00'} tone="neutral" />
        </div>
        <div>
          <div className="text-ink-muted text-xs">Linked</div>
          <Money value={detail.linkedTotal} tone="income" />
        </div>
        <div>
          <div className="text-ink-muted text-xs">Outstanding</div>
          <span className="inline-flex items-center gap-1">
            <Money value={detail.outstanding} tone="neutral" />
            {Number(detail.outstanding) === 0 && <CheckCircle2 size={12} className="text-sky" />}
          </span>
        </div>
      </div>

      <div className="mt-3.5 flex flex-col gap-2">
        {detail.status !== 'COMPLETE' && (
          <Button
            type="button"
            variant="secondary"
            icon={CheckCircle2}
            loading={completeTogglePending}
            onClick={() => toggleComplete(true)}
          >
            Mark fully reimbursed
          </Button>
        )}
        {detail.status === 'COMPLETE' && detail.completedManually && (
          <Button
            type="button"
            variant="ghost"
            loading={completeTogglePending}
            onClick={() => toggleComplete(false)}
          >
            Unmark as fully reimbursed
          </Button>
        )}
        {detail.status === 'COMPLETE' && !detail.completedManually && (
          <p className="text-ink-muted text-xs">
            Derived from linked amount — will revert automatically if a link is removed.
          </p>
        )}
        <Button type="button" icon={Plus} loading={persistPending} onClick={openPicker}>
          Link income
        </Button>
      </div>

      <div className="mt-3.5">
        {detail.links.length === 0 ? (
          <p className="text-ink-muted text-sm">
            No income linked yet. Link an income transaction as reimbursements arrive.
          </p>
        ) : (
          <div className="divide-line divide-y">
            {detail.links.map((link) => (
              <div key={link.id} className="flex items-center gap-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">
                    {link.incomePayee || 'Transaction'}
                  </div>
                  <div className="text-ink-muted text-xs">
                    {formatDate(link.incomeDate)} · {link.incomeAccountName}
                  </div>
                </div>
                {editingLinkId === link.id ? (
                  <div className="flex shrink-0 items-center gap-1.5">
                    <MoneyInput
                      aria-label="Amount for this link"
                      value={editAmountValue}
                      onValueChange={setEditAmountValue}
                      className="w-24"
                    />
                    <button
                      type="button"
                      aria-label="Save amount"
                      onClick={() => saveEdit(link.id)}
                      disabled={editPending}
                      className="text-sky p-1"
                    >
                      {editPending ? (
                        <Loader2 size={14} className="animate-spin" />
                      ) : (
                        <Check size={14} />
                      )}
                    </button>
                    <button
                      type="button"
                      aria-label="Cancel edit"
                      onClick={() => setEditingLinkId(null)}
                      className="text-ink-muted p-1"
                    >
                      <X size={14} />
                    </button>
                  </div>
                ) : (
                  <div className="flex shrink-0 items-center gap-1.5">
                    <Money value={link.amount} tone="income" />
                    <button
                      type="button"
                      aria-label={`Edit amount for ${link.incomePayee ?? 'this link'}`}
                      onClick={() => startEdit(link.id, link.amount)}
                      className="text-ink-muted hover:text-ink p-1"
                    >
                      <Pencil size={13} />
                    </button>
                    <button
                      type="button"
                      aria-label={`Remove link with ${link.incomePayee ?? 'this link'}`}
                      onClick={() => setRemoveConfirmLinkId(link.id)}
                      className="text-ink-muted hover:text-rose p-1"
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
        {editError && (
          <p className="text-rose mt-1 text-xs" role="alert">
            {editError}
          </p>
        )}
      </div>

      {actionError && (
        <p className="bg-rose-soft text-rose mt-3 rounded-lg px-3 py-2 text-sm" role="alert">
          {actionError}
        </p>
      )}

      {pickerOpen && (
        <ReimbursementLinkPicker
          key={pickerKey}
          expenseTransactionId={transaction.id}
          outstanding={detail.outstanding}
          onLinked={afterChange}
          onClose={() => setPickerOpen(false)}
        />
      )}
      <ConfirmDialog
        open={removeConfirmLinkId !== null}
        title="Remove reimbursement link"
        description="Remove this link? The income will no longer count toward this expense. This can't be undone."
        pending={removePending}
        onConfirm={() => removeConfirmLinkId && removeLink(removeConfirmLinkId)}
        onCancel={() => setRemoveConfirmLinkId(null)}
      />
    </div>
  );
};
