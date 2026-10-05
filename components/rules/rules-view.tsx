'use client';

import { useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { AnimatePresence, m } from 'framer-motion';
import { Check, Download, Pencil, Plus, Search, Trash2, Upload, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/field';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Modal } from '@/components/ui/modal';
import { deleteJSON, patchJSON, postJSON } from '@/lib/api-client';
import { listItemMotion } from '@/lib/motion/tokens';
import { useAnimateListChange } from '@/lib/motion/use-animate-list-change';
import type { FrontendCategoryRule } from '@/lib/services/categoryRules';
import type { FrontendCategory } from '@/lib/services/categories';

type ImportResult = {
  imported: number;
  skipped: Array<{ matchText: string; reason: string }>;
  createdCategories: string[];
};

type PreviewRow = {
  matchText: string;
  categoryName: string;
  priority: number;
  status: 'ready' | 'skip' | 'will-create';
  reason?: string;
  newCategoryName?: string;
};

export const RulesView = ({
  initialRules,
  categories,
}: {
  initialRules: FrontendCategoryRule[];
  categories: FrontendCategory[];
}): React.ReactElement => {
  const router = useRouter();
  const importInputRef = useRef<HTMLInputElement>(null);
  const [matchText, setMatchText] = useState('');
  const [categoryId, setCategoryId] = useState(categories[0]?.id ?? '');
  const [priority, setPriority] = useState('0');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deletePending, setDeletePending] = useState(false);
  const [search, setSearch] = useState('');
  const [showAddForm, setShowAddForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editPriority, setEditPriority] = useState('0');
  const [editPending, setEditPending] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [previewRows, setPreviewRows] = useState<PreviewRow[] | null>(null);
  const [included, setIncluded] = useState<Set<number>>(new Set());
  const [confirming, setConfirming] = useState(false);

  const query = search.trim().toLowerCase();
  const visibleRules = useMemo(
    () =>
      query
        ? initialRules.filter(
            (r) =>
              r.matchText.toLowerCase().includes(query) ||
              r.categoryName.toLowerCase().includes(query),
          )
        : initialRules,
    [initialRules, query],
  );
  // Typing in search swaps many rows at once; only a delete or add animates.
  const animateRules = useAnimateListChange(visibleRules.map((r) => r.id));
  const ruleMotion = {
    ...listItemMotion,
    layout: animateRules ? listItemMotion.layout : false,
    initial: animateRules ? listItemMotion.initial : false,
  } as const;

  const handleAdd = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setPending(true);
    setError(null);
    const res = await postJSON('/api/rules', { matchText, categoryId, priority });
    setPending(false);
    if (!res.ok) {
      setError('Could not add that rule.');
      return;
    }
    setMatchText('');
    setShowAddForm(false);
    router.refresh();
  };

  const handleDelete = async (id: string): Promise<void> => {
    setDeletePending(true);
    await deleteJSON(`/api/rules/${id}`);
    setDeletePending(false);
    setConfirmDeleteId(null);
    router.refresh();
  };

  const startEditPriority = (rule: FrontendCategoryRule): void => {
    setEditingId(rule.id);
    setEditPriority(String(rule.priority));
    setEditError(null);
  };

  const cancelEditPriority = (): void => {
    setEditingId(null);
    setEditError(null);
  };

  const saveEditPriority = async (id: string): Promise<void> => {
    if (editPriority.trim() === '') {
      setEditError('Priority is required.');
      return;
    }
    if (Number(editPriority) < 0) {
      setEditError('Priority cannot be negative.');
      return;
    }
    setEditPending(true);
    setEditError(null);
    const res = await patchJSON(`/api/rules/${id}`, { priority: editPriority });
    setEditPending(false);
    if (!res.ok) {
      setEditError('Could not update priority.');
      return;
    }
    setEditingId(null);
    router.refresh();
  };

  const handleImportFile = async (event: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.target.files?.[0];
    if (!file) return;
    setImportError(null);
    setImportResult(null);
    setImporting(true);

    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      const res = await postJSON<{ rows: PreviewRow[] }>('/api/rules/import/preview', parsed);
      if (!res.ok) {
        setImportError('Could not read that file. Check it was exported from Rules.');
        return;
      }
      const { rows } = res.data;
      setPreviewRows(rows);
      setIncluded(new Set(rows.flatMap((r, i) => (r.status === 'ready' ? [i] : []))));
    } catch {
      setImportError('That file is not valid JSON.');
    } finally {
      setImporting(false);
      if (importInputRef.current) importInputRef.current.value = '';
    }
  };

  const toggleIncluded = (index: number): void => {
    setIncluded((prev) => {
      const next = new Set(prev);
      if (next.has(index)) {
        next.delete(index);
      } else {
        next.add(index);
      }
      return next;
    });
  };

  const cancelImport = (): void => {
    setPreviewRows(null);
    setIncluded(new Set());
  };

  const confirmImport = async (): Promise<void> => {
    if (!previewRows || included.size === 0) return;
    setConfirming(true);
    setImportError(null);
    const rules = previewRows
      .filter((_, i) => included.has(i))
      .map(({ matchText, categoryName, priority }) => ({ matchText, categoryName, priority }));

    const res = await postJSON<ImportResult>('/api/rules/import', { rules });
    setConfirming(false);
    if (!res.ok) {
      setImportError('Could not import the selected rules.');
      return;
    }
    setImportResult(res.data);
    setPreviewRows(null);
    setIncluded(new Set());
    router.refresh();
  };

  return (
    <div className="mt-6.5">
      <div className="mb-4.5 flex justify-end gap-2">
        <a
          href="/api/rules/export"
          download="trackaloonie-rules.json"
          className="border-line text-ink hover:border-iris inline-flex items-center gap-2 rounded-full border px-4 py-2 text-sm font-medium transition-colors duration-150"
        >
          <Upload size={16} />
          Export rules
        </a>
        <input
          ref={importInputRef}
          type="file"
          accept="application/json,.json"
          onChange={handleImportFile}
          className="hidden"
        />
        <Button
          type="button"
          variant="secondary"
          icon={Download}
          loading={importing}
          onClick={() => importInputRef.current?.click()}
        >
          Import rules
        </Button>
      </div>

      {importError && (
        <p role="alert" className="text-rose mb-4 text-sm">
          {importError}
        </p>
      )}
      {importResult && (
        <p role="status" className="bg-sky-soft text-sky mb-4 rounded-lg px-4 py-3 text-sm">
          Imported {importResult.imported} rule{importResult.imported === 1 ? '' : 's'}.
          {importResult.createdCategories.length > 0 &&
            ` Created ${importResult.createdCategories.length} new categor${
              importResult.createdCategories.length === 1 ? 'y' : 'ies'
            }: ${importResult.createdCategories.join(', ')}.`}
          {importResult.skipped.length > 0 &&
            ` Skipped ${importResult.skipped.length}: ${importResult.skipped
              .map((s) => `"${s.matchText}" (${s.reason})`)
              .join(', ')}.`}
        </p>
      )}

      {categories.length === 0 ? (
        <div className="border-line bg-paper-raised flex flex-col items-center gap-3 rounded-2xl border border-dashed p-8 text-center">
          <p className="text-ink-muted text-sm">
            You don&apos;t have any categories yet. Add one to start writing rules.
          </p>
          <Link
            href="/categories"
            className="bg-iris text-paper-raised focus-visible:outline-iris inline-flex cursor-pointer items-center justify-center gap-2 rounded-full px-4 py-2 text-sm font-medium transition-colors duration-150 hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2"
          >
            <Plus size={16} />
            Add categories
          </Link>
        </div>
      ) : (
        <>
          {/* Desktop: always-visible inline form, plenty of width for four
              fields in a row. */}
          <form
            onSubmit={handleAdd}
            className="border-line bg-paper-raised hidden items-end gap-2.5 rounded-2xl border p-4.5 lg:flex"
          >
            <div className="flex-1">
              <label className="text-ink-muted mb-1.5 block text-[11px] font-semibold tracking-[0.06em] uppercase">
                When the description contains
              </label>
              <Input
                className="rounded-[9px]"
                value={matchText}
                onChange={(e) => setMatchText(e.target.value)}
                placeholder="e.g. superstore"
                required
              />
            </div>
            <div className="w-[200px]">
              <label className="text-ink-muted mb-1.5 block text-[11px] font-semibold tracking-[0.06em] uppercase">
                Categorize as
              </label>
              <Select
                className="rounded-[9px]"
                value={categoryId}
                onChange={(e) => setCategoryId(e.target.value)}
                required
              >
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </div>
            <div className="w-20">
              <label className="text-ink-muted mb-1.5 block text-[11px] font-semibold tracking-[0.06em] uppercase">
                Priority
              </label>
              <Input
                className="rounded-[9px] font-mono"
                type="number"
                min="0"
                value={priority}
                onChange={(e) => setPriority(e.target.value)}
              />
            </div>
            <Button type="submit" icon={Plus} loading={pending} className="px-4.5 py-2.5">
              Add rule
            </Button>
          </form>

          {/* Mobile: search bar + a dashed "New rule" CTA that reveals the
              same form fields stacked, instead of squeezing four fields
              into 402px. */}
          <div className="lg:hidden">
            <div className="border-line bg-paper-raised flex items-center gap-2.25 rounded-full border px-3.75 py-0">
              <Search size={15} className="text-ink-muted shrink-0" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search rules"
                className="placeholder:text-ink-muted/70 min-h-[46px] flex-1 bg-transparent text-sm outline-none"
              />
            </div>

            {showAddForm ? (
              <form
                onSubmit={handleAdd}
                className="border-line bg-paper-raised mt-2.5 flex flex-col gap-2.5 rounded-2xl border p-4.5"
              >
                <div>
                  <label className="text-ink-muted mb-1.5 block text-[11px] font-semibold tracking-[0.06em] uppercase">
                    When the description contains
                  </label>
                  <Input
                    className="rounded-[9px]"
                    value={matchText}
                    onChange={(e) => setMatchText(e.target.value)}
                    placeholder="e.g. superstore"
                    required
                    autoFocus
                  />
                </div>
                <div>
                  <label className="text-ink-muted mb-1.5 block text-[11px] font-semibold tracking-[0.06em] uppercase">
                    Categorize as
                  </label>
                  <Select
                    className="rounded-[9px]"
                    value={categoryId}
                    onChange={(e) => setCategoryId(e.target.value)}
                    required
                  >
                    {categories.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </Select>
                </div>
                <div>
                  <label className="text-ink-muted mb-1.5 block text-[11px] font-semibold tracking-[0.06em] uppercase">
                    Priority
                  </label>
                  <Input
                    className="rounded-[9px] font-mono"
                    type="number"
                    min="0"
                    value={priority}
                    onChange={(e) => setPriority(e.target.value)}
                  />
                </div>
                <div className="flex gap-2.5">
                  <button
                    type="button"
                    onClick={() => setShowAddForm(false)}
                    className="border-line text-ink flex-1 rounded-full border py-2.5 text-[14px] font-medium"
                  >
                    Cancel
                  </button>
                  <Button
                    type="submit"
                    icon={Plus}
                    loading={pending}
                    className="flex-[1.3] justify-center py-2.5"
                  >
                    Add rule
                  </Button>
                </div>
              </form>
            ) : (
              <button
                type="button"
                onClick={() => setShowAddForm(true)}
                className="border-iris/45 bg-iris-soft text-iris mt-2.5 block w-full rounded-full border border-dashed py-3 text-[14px] font-semibold"
              >
                + New rule
              </button>
            )}
          </div>
        </>
      )}
      {error && <p className="text-rose mt-2 text-sm">{error}</p>}

      {initialRules.length === 0 ? (
        categories.length > 0 && (
          <p className="text-ink-muted mt-6 text-sm">
            No rules yet. Everything falls back to no category.
          </p>
        )
      ) : (
        <>
          {initialRules.length > 10 && (
            <div className="relative mt-4.5 hidden lg:block">
              <Search
                size={15}
                className="text-ink-muted pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2"
              />
              <Input
                className="bg-paper-raised rounded-full pl-9"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search by match text or category"
              />
            </div>
          )}
          <div className="border-line bg-paper-raised relative mt-4.5 hidden rounded-2xl border px-6 lg:block">
            <div className="border-line text-ink-muted flex items-center gap-5 border-b py-3.5 text-[11px] font-semibold tracking-[0.08em] uppercase">
              <span className="flex-1">Match</span>
              <span className="w-[150px]">Category</span>
              <span className="w-[118px] text-right">Priority</span>
              <span className="w-[90px] text-right">Applied</span>
              <span className="w-[60px]" />
            </div>
            {visibleRules.length === 0 ? (
              <p className="text-ink-muted py-6 text-center text-sm">
                No rules match &ldquo;{search}&rdquo;.
              </p>
            ) : (
              <AnimatePresence mode="popLayout" initial={false} custom={animateRules}>
                {visibleRules.map((rule) => (
                  <m.div
                    key={rule.id}
                    {...ruleMotion}
                    className="ledger-row flex items-center gap-5 py-3.5"
                  >
                    <span className="min-w-0 flex-1 font-mono text-[13px]">
                      contains &ldquo;{rule.matchText}&rdquo;
                    </span>
                    <span className="w-[150px]">
                      <span className="border-line text-ink-muted rounded-full border px-2.5 py-1 text-[12.5px]">
                        {rule.categoryName}
                      </span>
                    </span>
                    <span className="relative w-[118px] text-right">
                      {editingId === rule.id ? (
                        <span className="flex items-center justify-end gap-1">
                          <Input
                            className="w-14 shrink-0 rounded-[9px] px-2 py-1 text-right font-mono text-[13px]"
                            type="number"
                            min="0"
                            autoFocus
                            value={editPriority}
                            onChange={(e) => setEditPriority(e.target.value)}
                          />
                          <button
                            type="button"
                            onClick={() => saveEditPriority(rule.id)}
                            disabled={editPending}
                            className="text-sky hover:text-ink inline-flex items-center p-1 disabled:opacity-50"
                            aria-label="Save priority"
                          >
                            <Check size={14} />
                          </button>
                          <button
                            type="button"
                            onClick={cancelEditPriority}
                            disabled={editPending}
                            className="text-ink-muted hover:text-ink inline-flex items-center p-1 disabled:opacity-50"
                            aria-label="Cancel edit"
                          >
                            <X size={14} />
                          </button>
                          {editError && (
                            <span className="text-rose bg-paper-raised border-line absolute top-full right-0 z-10 mt-1 w-max max-w-[200px] rounded-md border px-2 py-1 text-xs whitespace-normal">
                              {editError}
                            </span>
                          )}
                        </span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => startEditPriority(rule)}
                          className="text-ink-muted hover:text-iris inline-flex items-center gap-1 font-mono text-[13px] tabular-nums"
                          title="Lower number wins when more than one rule matches"
                        >
                          {rule.priority}
                          <Pencil size={11} />
                        </button>
                      )}
                    </span>
                    <span className="text-ink-muted w-[90px] text-right font-mono text-[13px] tabular-nums">
                      {rule.appliedCount}
                    </span>
                    <span className="w-[60px] text-right">
                      <button
                        type="button"
                        onClick={() => setConfirmDeleteId(rule.id)}
                        className="text-ink-muted hover:text-rose inline-flex items-center gap-1 text-[12.5px]"
                      >
                        <Trash2 size={13} />
                        Delete
                      </button>
                    </span>
                  </m.div>
                ))}
              </AnimatePresence>
            )}
          </div>

          {/* Mobile: one card per rule — the desktop table's fixed columns
              don't fit at 402px. */}
          <div className="mt-4.5 lg:hidden">
            {visibleRules.some((r) => r.overlapCount > 0) && (
              <div className="border-iris/35 bg-iris-soft mb-3 flex items-start gap-2.5 rounded-xl border p-3.5">
                <span className="bg-iris text-paper-raised mt-0.5 flex size-4.5 shrink-0 items-center justify-center rounded-full text-[12px] font-semibold">
                  !
                </span>
                <p className="text-ink-muted text-[12.5px] leading-snug">
                  Some rules can match the same payee. Only those need a priority — the rest
                  don&rsquo;t show one.
                </p>
              </div>
            )}

            {visibleRules.length === 0 ? (
              <p className="text-ink-muted py-6 text-center text-sm">
                No rules match &ldquo;{search}&rdquo;.
              </p>
            ) : (
              <div className="relative flex flex-col gap-2.5">
                <AnimatePresence mode="popLayout" initial={false} custom={animateRules}>
                  {visibleRules.map((rule) => (
                    <m.div
                      key={rule.id}
                      {...ruleMotion}
                      className="border-line bg-paper-raised rounded-2xl border p-4"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="font-mono text-[13.5px] break-words">
                            contains &ldquo;{rule.matchText}&rdquo;
                          </div>
                          <div className="mt-2 flex items-center gap-1.5">
                            <span className="text-ink-muted text-[11px]">→</span>
                            <span className="border-line text-ink-muted rounded-full border px-2.5 py-1 text-[12.5px]">
                              {rule.categoryName}
                            </span>
                          </div>
                          {rule.overlapCount > 0 ? (
                            <div className="mt-2.5 flex flex-wrap items-center gap-2">
                              <span className="bg-rose-soft text-rose rounded-full px-2.25 py-1 text-[11px] font-semibold">
                                Overlaps {rule.overlapCount} rule
                                {rule.overlapCount === 1 ? '' : 's'}
                              </span>
                              {rule.overlap && (
                                <span className="text-ink-muted text-[11.5px]">
                                  {rule.overlap.wins ? 'Wins over' : 'Loses to'} &ldquo;
                                  {rule.overlap.matchText}&rdquo; · priority {rule.overlap.priority}
                                </span>
                              )}
                            </div>
                          ) : (
                            <div className="text-ink-muted mt-2.5 text-[11.5px]">
                              {rule.appliedCount > 0
                                ? `Applied to ${rule.appliedCount} transaction${rule.appliedCount === 1 ? '' : 's'}`
                                : 'Never matched — check the spelling'}
                            </div>
                          )}
                          {editingId === rule.id && (
                            <div className="mt-2.5 flex items-center gap-1.5">
                              <span className="text-ink-muted text-[11.5px]">Priority</span>
                              <Input
                                className="w-16 shrink-0 rounded-[9px] px-2 py-1 text-right font-mono text-[13px]"
                                type="number"
                                min="0"
                                autoFocus
                                value={editPriority}
                                onChange={(e) => setEditPriority(e.target.value)}
                              />
                              <button
                                type="button"
                                onClick={() => saveEditPriority(rule.id)}
                                disabled={editPending}
                                className="text-sky hover:text-ink inline-flex items-center p-1 disabled:opacity-50"
                                aria-label="Save priority"
                              >
                                <Check size={16} />
                              </button>
                              <button
                                type="button"
                                onClick={cancelEditPriority}
                                disabled={editPending}
                                className="text-ink-muted hover:text-ink inline-flex items-center p-1 disabled:opacity-50"
                                aria-label="Cancel edit"
                              >
                                <X size={16} />
                              </button>
                            </div>
                          )}
                          {editError && editingId === rule.id && (
                            <p className="text-rose mt-1 text-xs">{editError}</p>
                          )}
                        </div>
                        <div className="flex shrink-0 gap-1">
                          <button
                            type="button"
                            onClick={() => startEditPriority(rule)}
                            aria-label="Edit rule"
                            className="text-ink-muted flex size-9 items-center justify-center"
                          >
                            <Pencil size={16} />
                          </button>
                          <button
                            type="button"
                            onClick={() => setConfirmDeleteId(rule.id)}
                            aria-label="Delete rule"
                            className="text-ink-muted hover:text-rose flex size-9 items-center justify-center"
                          >
                            <Trash2 size={16} />
                          </button>
                        </div>
                      </div>
                    </m.div>
                  ))}
                </AnimatePresence>
              </div>
            )}
          </div>
        </>
      )}
      <ConfirmDialog
        open={confirmDeleteId !== null}
        title="Delete rule"
        description="Delete this categorization rule? Transactions won't be recategorized automatically anymore for this match."
        pending={deletePending}
        onConfirm={() => confirmDeleteId && handleDelete(confirmDeleteId)}
        onCancel={() => setConfirmDeleteId(null)}
      />
      <Modal
        open={previewRows !== null}
        onClose={cancelImport}
        title="Review rules to import"
        className="max-w-lg"
      >
        {previewRows && (
          <>
            <p className="text-ink-muted mb-3 text-sm">
              {included.size} of {previewRows.length} selected. Uncheck any row to leave it out.
            </p>
            <div className="border-line max-h-80 overflow-y-auto rounded-lg border">
              {previewRows.map((row, i) => (
                <label
                  key={`${row.matchText}-${row.categoryName}-${i}`}
                  className="border-line flex cursor-pointer items-start gap-2.5 border-b p-2.5 text-sm last:border-b-0"
                >
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={included.has(i)}
                    onChange={() => toggleIncluded(i)}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-mono text-[12.5px]">
                      &ldquo;{row.matchText}&rdquo;
                    </span>
                    <span className="text-ink-muted block text-[12px]">
                      {row.status === 'ready' && <>→ {row.categoryName}</>}
                      {row.status === 'will-create' && (
                        <span className="bg-iris-soft text-iris mt-1 inline-block rounded-full px-2.5 py-1 text-[12.5px]">
                          Will create category &ldquo;{row.newCategoryName}&rdquo;
                        </span>
                      )}
                      {row.status === 'skip' && (
                        <span className="text-rose">Skipped: {row.reason}</span>
                      )}
                    </span>
                  </span>
                </label>
              ))}
            </div>
            {importError && (
              <p className="text-rose mt-3 text-sm" role="alert">
                {importError}
              </p>
            )}
            <div className="mt-4 flex justify-end gap-2">
              <Button type="button" variant="secondary" onClick={cancelImport}>
                Cancel
              </Button>
              <Button
                type="button"
                onClick={confirmImport}
                loading={confirming}
                disabled={included.size === 0}
              >
                Import {included.size > 0 ? included.size : ''} rule
                {included.size === 1 ? '' : 's'}
              </Button>
            </div>
          </>
        )}
      </Modal>
    </div>
  );
};
