'use client';

import { useEffect, useRef, useState } from 'react';
import { Check, Loader2 } from 'lucide-react';
import { Modal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { Input, Label } from '@/components/ui/field';
import { MoneyInput } from '@/components/ui/money-input';
import { Money } from '@/components/ui/money';
import { formatDate } from '@/lib/format';
import { getJSON, postJSON } from '@/lib/api-client';
import { cn } from '@/lib/cn';
import type { ReimbursementCandidate } from '@/lib/services/reimbursements';

const SUGGESTED_COUNT = 3;
const SEARCH_DEBOUNCE_MS = 400;

export const ReimbursementLinkPicker = ({
  expenseTransactionId,
  onLinked,
  onClose,
}: {
  expenseTransactionId: string;
  outstanding: string;
  onLinked: () => void;
  onClose: () => void;
}): React.ReactElement => {
  const [search, setSearch] = useState('');
  const [candidates, setCandidates] = useState<ReimbursementCandidate[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [amount, setAmount] = useState('');
  const [confirmPending, setConfirmPending] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = async (searchTerm: string): Promise<void> => {
    setLoadError(null);
    const params = new URLSearchParams();
    if (searchTerm) params.set('search', searchTerm);
    const res = await getJSON<ReimbursementCandidate[]>(
      `/api/transactions/${expenseTransactionId}/reimbursement/candidates?${params.toString()}`,
    );
    if (!res.ok) {
      setLoadError("Couldn't load candidates.");
      return;
    }
    setCandidates(res.data);
  };

  useEffect(() => {
    (async () => {
      await load('');
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => load(search), SEARCH_DEBOUNCE_MS);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  const select = (candidate: ReimbursementCandidate): void => {
    setSelectedId(candidate.transactionId);
    setAmount(candidate.suggestedAmount);
    setConfirmError(null);
  };

  const confirm = async (): Promise<void> => {
    if (!selectedId) return;
    setConfirmPending(true);
    setConfirmError(null);
    const res = await postJSON('/api/reimbursement-links', {
      expenseTransactionId,
      incomeTransactionId: selectedId,
      amount,
    });
    setConfirmPending(false);
    if (!res.ok) {
      setConfirmError(res.error ?? 'Could not link this income.');
      return;
    }
    onLinked();
    onClose();
  };

  const renderCandidate = (candidate: ReimbursementCandidate): React.ReactElement => {
    const selected = candidate.transactionId === selectedId;
    return (
      <div key={candidate.transactionId}>
        <button
          type="button"
          onClick={() => select(candidate)}
          className={cn(
            'flex w-full items-center justify-between gap-3 rounded-lg border px-3 py-2.5 text-left',
            selected ? 'border-iris bg-iris-soft' : 'border-line',
          )}
        >
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium">{candidate.payee || 'Transaction'}</div>
            <div className="text-ink-muted text-xs">
              {formatDate(candidate.date)} · {candidate.accountName}
              {candidate.categoryName ? ` · ${candidate.categoryName}` : ''}
            </div>
            <div className="mt-1 flex flex-wrap gap-1">
              {candidate.reasons.map((reason) => (
                <span
                  key={reason}
                  className="border-line text-ink-muted rounded-full border px-2 py-0.5 text-[11px]"
                >
                  {reason}
                </span>
              ))}
            </div>
          </div>
          <div className="shrink-0 text-right">
            <Money value={candidate.amount} tone="income" />
            <div className="text-ink-muted font-mono text-[11px]">
              available {candidate.availableAmount}
            </div>
          </div>
        </button>
        {selected && (
          <div className="mt-2 pl-3">
            <Label htmlFor={`link-amount-${candidate.transactionId}`}>Amount to link</Label>
            <MoneyInput
              id={`link-amount-${candidate.transactionId}`}
              value={amount}
              onValueChange={setAmount}
            />
            {confirmError && (
              <p className="text-rose mt-1 text-xs" role="alert">
                {confirmError}
              </p>
            )}
            <div className="mt-2 flex gap-2">
              <Button type="button" icon={Check} loading={confirmPending} onClick={confirm}>
                Confirm link
              </Button>
              <Button type="button" variant="ghost" onClick={() => setSelectedId(null)}>
                Change selection
              </Button>
            </div>
          </div>
        )}
      </div>
    );
  };

  const suggested = candidates?.slice(0, SUGGESTED_COUNT) ?? [];
  const more = candidates?.slice(SUGGESTED_COUNT) ?? [];

  return (
    <Modal open onClose={onClose} title="Link income">
      <Label htmlFor="reimbursement-candidate-search">Search income transactions</Label>
      <Input
        id="reimbursement-candidate-search"
        autoFocus
        placeholder="Search payee, note, account, category or amount…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />

      <div className="mt-3 flex max-h-80 flex-col gap-3 overflow-y-auto">
        {loadError && (
          <>
            <p className="text-rose text-sm" role="alert">
              {loadError}
            </p>
            <Button type="button" variant="ghost" onClick={() => load(search)}>
              Retry
            </Button>
          </>
        )}
        {!loadError && candidates === null && (
          <div className="flex items-center gap-2">
            <Loader2 size={14} className="animate-spin" />
            <span className="text-ink-muted text-sm" role="status">
              Loading candidates…
            </span>
          </div>
        )}
        {!loadError && candidates !== null && candidates.length === 0 && (
          <p className="text-ink-muted py-4 text-center text-sm">
            {search.trim() ? (
              'No income matches that search.'
            ) : (
              <>
                No income transactions to link yet.
                <br />
                Add or import the income first, then come back to link it here.
              </>
            )}
          </p>
        )}
        {!loadError && suggested.length > 0 && (
          <div className="flex flex-col gap-2">
            <span className="text-ink-muted text-[11px] font-semibold tracking-[0.1em] uppercase">
              Suggested
            </span>
            {suggested.map(renderCandidate)}
          </div>
        )}
        {!loadError && more.length > 0 && (
          <div className="flex flex-col gap-2">
            <span className="text-ink-muted text-[11px] font-semibold tracking-[0.1em] uppercase">
              More matches
            </span>
            {more.map(renderCandidate)}
          </div>
        )}
      </div>
    </Modal>
  );
};
