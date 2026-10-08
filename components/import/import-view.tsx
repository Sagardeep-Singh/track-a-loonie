'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Papa from 'papaparse';
import { Check, Eye, Upload } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Label, Select } from '@/components/ui/field';
import { Money } from '@/components/ui/money';
import { isLiabilityAccountType } from '@/lib/account-types';
import { postJSON } from '@/lib/api-client';
import { formatDate } from '@/lib/format';
import { cn } from '@/lib/cn';
import { categoryColorVar } from '@/lib/ui/category-color';
import {
  guessSplitColumns,
  parseCsvAmount,
  resolveImportedTransactionType,
  resolveSplitColumnAmount,
} from '@/lib/import';
import type { FrontendAccount } from '@/lib/services/accounts';
import type { FrontendCategory } from '@/lib/services/categories';
import type { FrontendImportBatch } from '@/lib/services/importBatches';

type CsvRow = Record<string, string>;

type FilenameWarning = {
  batch: FrontendImportBatch;
  submittedRowCount: number;
  rowCountMatches: boolean;
  dateRangeMatches: boolean;
};

type PreviewRow = {
  accountId: string;
  date: string;
  amount: number;
  type: 'INCOME' | 'EXPENSE';
  payee?: string;
  note?: string;
  categoryId: string | null;
  categoryName: string | null;
  duplicate: boolean;
  include: boolean;
};

const NONE = '__none__';

/** One signed amount column, or separate credit (money in) / debit (money out) columns. */
type AmountLayout = 'single' | 'split';

export const ImportView = ({
  accounts,
  categories,
}: {
  accounts: FrontendAccount[];
  categories: FrontendCategory[];
}): React.ReactElement => {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [headers, setHeaders] = useState<string[]>([]);
  const [rawRows, setRawRows] = useState<CsvRow[]>([]);
  const [fileName, setFileName] = useState('');
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? '');
  const [dateCol, setDateCol] = useState('');
  const [amountLayout, setAmountLayout] = useState<AmountLayout>('single');
  const [amountCol, setAmountCol] = useState('');
  const [creditCol, setCreditCol] = useState('');
  const [debitCol, setDebitCol] = useState('');
  const [payeeCol, setPayeeCol] = useState('');
  const [noteCol, setNoteCol] = useState('');
  const [flipSigns, setFlipSigns] = useState(false);
  const [preview, setPreview] = useState<PreviewRow[] | null>(null);
  const [filenameWarning, setFilenameWarning] = useState<FilenameWarning | null>(null);
  const [duplicateBatch, setDuplicateBatch] = useState<FrontendImportBatch | null>(null);
  const [loading, setLoading] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [committed, setCommitted] = useState<{
    imported: number;
    skippedDuplicates: number;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleFile = (event: React.ChangeEvent<HTMLInputElement>): void => {
    const file = event.target.files?.[0];
    if (!file) return;
    setCommitted(null);
    setPreview(null);
    setError(null);
    setFilenameWarning(null);
    setDuplicateBatch(null);
    setFileName(file.name);

    Papa.parse<CsvRow>(file, {
      header: true,
      skipEmptyLines: true,
      complete: (result) => {
        const cols = result.meta.fields ?? [];
        setHeaders(cols);
        setRawRows(result.data);
        const guess = (needle: string): string =>
          cols.find((c) => c.toLowerCase().includes(needle)) ?? '';
        setDateCol(guess('date'));
        const amount = guess('amount');
        const split = guessSplitColumns(cols);
        setAmountCol(amount);
        setCreditCol(split.credit);
        setDebitCol(split.debit);
        // Default to the split layout only when there's no amount column to
        // fall back on and both split columns were found.
        setAmountLayout(!amount && split.credit && split.debit ? 'split' : 'single');
        setPayeeCol(guess('payee') || guess('description') || guess('merchant'));
        setNoteCol(guess('note') || guess('memo'));
      },
    });
  };

  // Bank/checking/savings CSVs use the debit convention: negative = money
  // out (expense), positive = money in (income). Credit card/line-of-credit
  // exports are inverted: a positive amount is a charge (expense), a
  // negative one is a payment or refund credited back (income).
  const selectedAccount = accounts.find((a) => a.id === accountId);
  const isCreditAccount = isLiabilityAccountType(selectedAccount?.type);

  const amountMapped =
    amountLayout === 'single' ? !!amountCol : !!creditCol && !!debitCol && creditCol !== debitCol;

  const handlePreview = async (): Promise<void> => {
    if (!dateCol || !amountMapped || !accountId) return;
    setError(null);
    setFilenameWarning(null);
    setDuplicateBatch(null);

    const rows = rawRows.flatMap((row) => {
      let resolved: { amount: number; type: 'INCOME' | 'EXPENSE' } | null;
      if (amountLayout === 'split') {
        // Blank in both columns (a balance or pending line) is dropped.
        resolved = resolveSplitColumnAmount(row[creditCol], row[debitCol]);
      } else {
        const amount = (parseCsvAmount(row[amountCol]) ?? NaN) * (flipSigns ? -1 : 1);
        resolved = {
          amount: Math.abs(amount),
          type: resolveImportedTransactionType(amount, selectedAccount?.type ?? ''),
        };
      }
      if (!resolved) return [];
      return [
        {
          accountId,
          date: row[dateCol],
          amount: resolved.amount,
          type: resolved.type,
          payee: payeeCol ? row[payeeCol] : undefined,
          note: noteCol ? row[noteCol] : undefined,
        },
      ];
    });
    if (rows.length === 0) {
      setError('No rows have an amount in the credit or debit column.');
      return;
    }
    setLoading(true);

    const res = await postJSON<{ rows: PreviewRow[]; filenameWarning: FilenameWarning | null }>(
      '/api/import/preview',
      { accountId, filename: fileName, rows },
    );

    setLoading(false);
    if (!res.ok) {
      setError('Could not preview these rows. Check your column mapping.');
      return;
    }
    const data = res.data;
    setPreview(data.rows);
    setFilenameWarning(data.filenameWarning);
  };

  const toggleInclude = (index: number): void => {
    if (!preview) return;
    const next = [...preview];
    next[index] = { ...next[index], include: !next[index].include };
    setPreview(next);
  };

  const overrideCategory = (index: number, categoryId: string | null): void => {
    if (!preview) return;
    const next = [...preview];
    next[index] = { ...next[index], categoryId };
    setPreview(next);
  };

  // `override` is an argument, not state: `handleFile` resets everything on a new
  // file, and a persisted override flag would silently carry the previous file's
  // intent into the next one and skip a 409 it should have hit.
  const handleCommit = async (override: boolean = false): Promise<void> => {
    if (!preview || committing) return;
    setCommitting(true);
    setLoading(true);
    setError(null);
    setDuplicateBatch(null);
    const res = await postJSON<{ imported: number; skippedDuplicates: number }>(
      '/api/import/commit',
      {
        accountId,
        filename: fileName,
        rows: preview,
        overrideDuplicateFilename: override,
      },
    );
    setLoading(false);
    if (!res.ok) {
      setCommitting(false);
      const body = res.body as { code?: string; batch?: FrontendImportBatch } | null;
      if (res.status === 409 && body?.code === 'DUPLICATE_FILENAME') {
        // keep the preview on screen: the rows stay reviewable behind the error
        setDuplicateBatch(body.batch as FrontendImportBatch);
        return;
      }
      setError('Import failed.');
      return;
    }
    setCommitted(res.data);
    setFilenameWarning(null);
    setDuplicateBatch(null);
    // committing was never reset on the success path, so every import after
    // the first silently no-op'd on the `committing` reentrancy guard above.
    setCommitting(false);

    // Reset everything so this file can't be re-submitted: another click on
    // "Import" after a successful commit was silently re-importing the same
    // rows, since the preview (and its duplicate flags) went stale the
    // moment the first commit landed.
    setHeaders([]);
    setRawRows([]);
    setFileName('');
    setPreview(null);
    setDateCol('');
    setAmountLayout('single');
    setAmountCol('');
    setCreditCol('');
    setDebitCol('');
    setPayeeCol('');
    setNoteCol('');
    if (fileInputRef.current) fileInputRef.current.value = '';

    router.refresh();
  };

  const skippedCount = preview ? preview.filter((r) => !r.include).length : 0;
  const skippedDuplicateCount = preview
    ? preview.filter((r) => !r.include && r.duplicate).length
    : 0;

  return (
    <div className="mt-6 flex flex-col gap-6">
      <Card>
        <Label htmlFor="csvfile">CSV file</Label>
        <input
          ref={fileInputRef}
          id="csvfile"
          type="file"
          accept=".csv,text/csv"
          onChange={handleFile}
          className="text-ink-muted file:bg-iris-soft file:text-iris mt-1 block w-full text-sm file:mr-3 file:rounded-full file:border-0 file:px-3 file:py-1.5 file:text-sm file:font-medium"
        />

        {headers.length > 0 && (
          <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <div>
              <Label htmlFor="account">Account</Label>
              <Select id="account" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <Label htmlFor="dateCol">Date column</Label>
              <Select id="dateCol" value={dateCol} onChange={(e) => setDateCol(e.target.value)}>
                <option value="">Select…</option>
                {headers.map((h) => (
                  <option key={h} value={h}>
                    {h}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <Label htmlFor="amountLayout">Amounts</Label>
              <Select
                id="amountLayout"
                value={amountLayout}
                onChange={(e) => setAmountLayout(e.target.value as AmountLayout)}
              >
                <option value="single">One amount column</option>
                <option value="split">Separate credit and debit columns</option>
              </Select>
            </div>
            {amountLayout === 'single' ? (
              <div>
                <Label htmlFor="amountCol">Amount column</Label>
                <Select
                  id="amountCol"
                  value={amountCol}
                  onChange={(e) => setAmountCol(e.target.value)}
                >
                  <option value="">Select…</option>
                  {headers.map((h) => (
                    <option key={h} value={h}>
                      {h}
                    </option>
                  ))}
                </Select>
              </div>
            ) : (
              <>
                <div>
                  <Label htmlFor="creditCol">Credit column (money in)</Label>
                  <Select
                    id="creditCol"
                    value={creditCol}
                    onChange={(e) => setCreditCol(e.target.value)}
                  >
                    <option value="">Select…</option>
                    {headers.map((h) => (
                      <option key={h} value={h}>
                        {h}
                      </option>
                    ))}
                  </Select>
                </div>
                <div>
                  <Label htmlFor="debitCol">Debit column (spending)</Label>
                  <Select
                    id="debitCol"
                    value={debitCol}
                    onChange={(e) => setDebitCol(e.target.value)}
                  >
                    <option value="">Select…</option>
                    {headers.map((h) => (
                      <option key={h} value={h}>
                        {h}
                      </option>
                    ))}
                  </Select>
                </div>
              </>
            )}
            <div>
              <Label htmlFor="payeeCol">Payee column (optional)</Label>
              <Select id="payeeCol" value={payeeCol} onChange={(e) => setPayeeCol(e.target.value)}>
                <option value="">None</option>
                {headers.map((h) => (
                  <option key={h} value={h}>
                    {h}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <Label htmlFor="noteCol">Note column (optional)</Label>
              <Select id="noteCol" value={noteCol} onChange={(e) => setNoteCol(e.target.value)}>
                <option value="">None</option>
                {headers.map((h) => (
                  <option key={h} value={h}>
                    {h}
                  </option>
                ))}
              </Select>
            </div>
            <div className="flex items-end">
              <Button
                type="button"
                onClick={handlePreview}
                icon={Eye}
                loading={loading}
                disabled={!dateCol || !amountMapped}
              >
                Preview
              </Button>
            </div>
          </div>
        )}
        {amountLayout === 'split' ? (
          <p className="bg-paper text-ink-muted mt-3 rounded-xl px-3.5 py-3 text-xs leading-snug">
            Credit amounts are imported as income (a payment or refund on a card), debit amounts as
            spending. Rows with neither are skipped.
          </p>
        ) : (
          <div className="bg-paper mt-3 flex items-center justify-between gap-3 rounded-xl px-3.5 py-3">
            <p className="text-ink-muted text-xs leading-snug">
              {isCreditAccount
                ? 'Positive amounts are treated as charges (expenses), negative as payments or refunds (income).'
                : 'Negative amounts are treated as expenses, positive as income.'}
            </p>
            <button
              type="button"
              onClick={() => setFlipSigns((v) => !v)}
              className={cn(
                'shrink-0 rounded-full border px-3.5 py-2 text-xs font-medium',
                flipSigns ? 'border-iris bg-iris-soft text-iris' : 'border-line text-ink',
              )}
            >
              {flipSigns ? 'Signs flipped' : 'Flip signs'}
            </button>
          </div>
        )}
      </Card>

      {error && <p className="text-rose text-sm">{error}</p>}

      {filenameWarning && (
        <p className="bg-sky-soft text-sky rounded-lg px-4 py-3 text-sm">
          A file named &ldquo;{fileName}&rdquo; was already imported into this account on{' '}
          {formatDate(filenameWarning.batch.createdAt)} ({filenameWarning.batch.rowCount} rows
          {filenameWarning.rowCountMatches && ', same row count'}
          {filenameWarning.dateRangeMatches && ', same date range'}). You can still import —
          duplicate rows will be flagged below.
        </p>
      )}

      {duplicateBatch && (
        <div className="bg-rose-soft border-rose/40 flex flex-col items-start gap-2 rounded-lg border px-4 py-3">
          <p className="text-rose text-sm font-medium">
            &ldquo;{duplicateBatch.filename}&rdquo; was already imported into this account on{' '}
            {formatDate(duplicateBatch.createdAt)}.
          </p>
          <p className="text-ink-muted text-xs">
            {duplicateBatch.rowCount} rows, {duplicateBatch.importedCount} imported.
          </p>
          <Button
            type="button"
            variant="danger"
            icon={Upload}
            loading={loading}
            onClick={() => handleCommit(true)}
          >
            Import anyway
          </Button>
        </div>
      )}

      {preview && (
        <>
          {/* Desktop: one card, flat divided rows, plenty of width for a
              fixed-column layout. */}
          <Card className="hidden p-0 lg:block">
            <div className="flex items-center justify-between px-6 py-4">
              <div className="text-ink-muted text-sm">
                {preview.length} row{preview.length === 1 ? '' : 's'} parsed ·{' '}
                {preview.filter((r) => r.duplicate).length} possible duplicate
                {preview.filter((r) => r.duplicate).length === 1 ? '' : 's'}
              </div>
              <Button
                onClick={() => handleCommit()}
                icon={Upload}
                loading={loading}
                disabled={preview.every((r) => !r.include)}
              >
                Import {preview.filter((r) => r.include).length} rows
              </Button>
            </div>
            {preview.map((row, i) => (
              <div
                key={i}
                className="ledger-row grid grid-cols-[auto_1fr_auto_1fr] items-center gap-4 px-6 py-3"
              >
                <input
                  type="checkbox"
                  checked={row.include}
                  onChange={() => toggleInclude(i)}
                  className="accent-iris h-4 w-4"
                />
                <div className="min-w-0">
                  <div className="text-ink truncate text-sm">
                    {row.payee || row.note || 'Row ' + (i + 1)}
                  </div>
                  <div className="text-ink-muted text-xs">
                    {formatDate(row.date)} {row.duplicate && '· possible duplicate'}
                  </div>
                </div>
                <Money value={row.amount} tone={row.type === 'INCOME' ? 'income' : 'expense'} />
                <Select
                  value={row.categoryId ?? NONE}
                  onChange={(e) =>
                    overrideCategory(i, e.target.value === NONE ? null : e.target.value)
                  }
                >
                  <option value={NONE}>Uncategorized</option>
                  {categories.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </Select>
              </div>
            ))}
          </Card>

          {/* Mobile: one card per row — a flat divided list crushes the
              payee/date column at 402px. */}
          <div className="lg:hidden">
            <div className="flex items-baseline justify-between gap-2.5">
              <span className="font-display text-base font-semibold">Preview</span>
              <span className="text-ink-muted text-xs">
                {preview.filter((r) => r.include).length} of {preview.length} selected
              </span>
            </div>

            <div className="mt-3 flex flex-col gap-2.5">
              {preview.map((row, i) =>
                row.duplicate ? (
                  <div key={i} className="border-iris/35 bg-paper-raised rounded-2xl border p-4">
                    <span className="bg-iris-soft text-iris rounded-full px-2.5 py-1 text-[10.5px] font-semibold tracking-[0.05em] uppercase">
                      Possible duplicate
                    </span>
                    <div className="mt-2.5 text-[14.5px] font-semibold">
                      {row.payee || row.note || 'Row ' + (i + 1)}
                    </div>
                    <div className="text-ink-muted mt-1 font-mono text-[12.5px]">
                      {formatDate(row.date)} ·{' '}
                      <Money
                        value={row.amount}
                        tone={row.type === 'INCOME' ? 'income' : 'expense'}
                        className="text-[12.5px]"
                      />
                    </div>
                    <div className="mt-3 flex gap-2">
                      <button
                        type="button"
                        onClick={() => row.include && toggleInclude(i)}
                        className={cn(
                          'flex-1 rounded-full py-2.5 text-[13px] font-semibold',
                          !row.include
                            ? 'bg-iris text-paper-raised'
                            : 'border-line text-ink border',
                        )}
                      >
                        Skip it
                      </button>
                      <button
                        type="button"
                        onClick={() => !row.include && toggleInclude(i)}
                        className={cn(
                          'flex-1 rounded-full py-2.5 text-[13px] font-medium',
                          row.include ? 'bg-iris-soft text-iris' : 'border-line text-ink border',
                        )}
                      >
                        Import anyway
                      </button>
                    </div>
                  </div>
                ) : (
                  <div key={i} className="border-line bg-paper-raised rounded-2xl border p-4">
                    <div className="flex items-start gap-3">
                      <button
                        type="button"
                        onClick={() => toggleInclude(i)}
                        aria-label={row.include ? 'Exclude row' : 'Include row'}
                        className={cn(
                          'mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-md',
                          row.include ? 'bg-iris' : 'border-line border',
                        )}
                      >
                        {row.include && (
                          <Check size={12} className="text-paper-raised" strokeWidth={2.5} />
                        )}
                      </button>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-baseline justify-between gap-3">
                          <span className="min-w-0 truncate text-[14.5px] font-semibold">
                            {row.payee || row.note || 'Row ' + (i + 1)}
                          </span>
                          <Money
                            value={row.amount}
                            tone={row.type === 'INCOME' ? 'income' : 'expense'}
                            className="shrink-0 text-[14.5px]"
                          />
                        </div>
                        <div className="text-ink-muted mt-1 font-mono text-[12px]">
                          {formatDate(row.date)}
                        </div>
                        <div className="mt-2">
                          <Select
                            value={row.categoryId ?? NONE}
                            onChange={(e) =>
                              overrideCategory(i, e.target.value === NONE ? null : e.target.value)
                            }
                            className="w-auto rounded-full border-0 py-1.5 pr-7 pl-2.5 text-xs font-medium"
                            style={
                              row.categoryName
                                ? {
                                    background: `color-mix(in srgb, ${categoryColorVar(row.categoryName)} 20%, var(--paper-raised))`,
                                    color: categoryColorVar(row.categoryName),
                                  }
                                : undefined
                            }
                          >
                            <option value={NONE}>Uncategorized</option>
                            {categories.map((c) => (
                              <option key={c.id} value={c.id}>
                                {c.name}
                              </option>
                            ))}
                          </Select>
                        </div>
                      </div>
                    </div>
                  </div>
                ),
              )}
            </div>

            <div
              className="border-line bg-paper-raised fixed inset-x-0 z-20 flex items-center gap-3 border-t px-4.5 py-3"
              style={{ bottom: 'calc(60px + env(safe-area-inset-bottom))' }}
            >
              <span className="text-ink-muted min-w-0 text-[12px] leading-tight">
                {skippedCount} skipped
                <br />
                {skippedCount > 0 && skippedCount === skippedDuplicateCount ? 'as duplicate' : ''}
              </span>
              <Button
                onClick={() => handleCommit()}
                icon={Upload}
                loading={loading}
                disabled={preview.every((r) => !r.include)}
                className="flex-1 justify-center py-3"
              >
                Import {preview.filter((r) => r.include).length} rows
              </Button>
            </div>
            <div className="h-24" />
          </div>
        </>
      )}

      {committed !== null && (
        <p className="bg-sky-soft text-sky rounded-lg px-4 py-3 text-sm">
          Imported {committed.imported} transaction{committed.imported === 1 ? '' : 's'}.
          {committed.skippedDuplicates > 0 &&
            ` Skipped ${committed.skippedDuplicates} duplicate${committed.skippedDuplicates === 1 ? '' : 's'}.`}
        </p>
      )}
    </div>
  );
};
