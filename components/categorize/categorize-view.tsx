'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AnimatePresence, m } from 'framer-motion';
import { Check, CheckCheck, SkipForward } from 'lucide-react';
import { patchJSON, postJSON, type ApiResult } from '@/lib/api-client';
import { cn } from '@/lib/cn';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/field';
import { Toast } from '@/components/ui/toast';
import { listItemMotion } from '@/lib/motion/tokens';
import { SuggestAiButton } from '@/components/categorize/suggest-ai-button';
import type { CategorizeProgress, CategorizeQueueRow } from '@/lib/services/categorize';
import type { FrontendCategory } from '@/lib/services/categories';
import type { FrontendAiSettings } from '@/lib/services/aiSettings';
import type { AiSuggestion } from '@/lib/services/aiCategorize';

type PayeeGroup = {
  payee: string;
  rows: CategorizeQueueRow[];
  totalAmount: number;
  meta: string;
  suggestedCategoryId: string | null;
  suggestedCategoryName: string | null;
  why: string | null;
};

const patchCategory = (id: string, categoryId: string | null): Promise<ApiResult<unknown>> =>
  patchJSON(`/api/transactions/${id}`, { categoryId });

const skipTransaction = (id: string): Promise<ApiResult<unknown>> =>
  postJSON(`/api/transactions/${id}/skip`);

/** Result of a suggest call, shown inline next to the triggering row/card —
 * matching the `matchResult` precedent in transactions-view.tsx rather than a
 * Toast, since it belongs to one row, not to the page. `alert` for a real
 * failure, `status` for the informational "no confident match". */
type AiRowResult = { message: string; tone: 'alert' | 'status' };

export const CategorizeView = ({
  initialQueue,
  categories,
  progress,
  aiSettings,
}: {
  initialQueue: CategorizeQueueRow[];
  categories: FrontendCategory[];
  progress: CategorizeProgress;
  aiSettings: FrontendAiSettings;
}): React.ReactElement => {
  const router = useRouter();
  const [queue, setQueue] = useState(initialQueue);
  const [reviewOne, setReviewOne] = useState(false);
  const [pending, setPending] = useState(false);
  const [toast, setToast] = useState<{ message: string; undo: () => void } | null>(null);
  const [groupChoice, setGroupChoice] = useState<Record<string, string>>({});
  const [groupMore, setGroupMore] = useState<Record<string, boolean>>({});
  // Renders in pages: a payee-per-card list has no natural cap, and a large
  // uncategorized backlog (many one-off, never-repeating payees) can mean
  // hundreds of groups — rendering them all at once is what made the page
  // unresponsive during testing.
  const GROUP_PAGE_SIZE = 60;
  const [visibleGroupCount, setVisibleGroupCount] = useState(GROUP_PAGE_SIZE);

  // AI suggestions land here first, by transaction id — they are never applied
  // automatically. Accepting one goes through the same explicit category-set
  // action a rule suggestion does.
  const [aiSuggestions, setAiSuggestions] = useState<Record<string, string>>({});
  const [suggestingId, setSuggestingId] = useState<string | null>(null);
  const [aiResults, setAiResults] = useState<Record<string, AiRowResult>>({});
  const [dailyCapHit, setDailyCapHit] = useState<string | null>(null);

  // No key, no button at all — rather than a disabled one with a hint. A
  // permanently-inert control in every queue row is noise for the (majority)
  // case of a user who has not opted into BYOK. The daily cap is different: it
  // is temporary and the user needs to know why the button stopped working.
  const showSuggest = aiSettings.available && aiSettings.configured;

  const suggestAi = async (transactionId: string): Promise<void> => {
    setSuggestingId(transactionId);
    setAiResults((r) => {
      const next = { ...r };
      delete next[transactionId];
      return next;
    });
    try {
      const response = await postJSON<AiSuggestion>('/api/categorize/suggest-ai', {
        transactionId,
      });

      if (!response.ok) {
        const message = response.error ?? 'Could not get a suggestion. Try again in a moment.';
        setAiResults((r) => ({ ...r, [transactionId]: { message, tone: 'alert' } }));
        // The daily cap is the one failure that stays true for the rest of the
        // day, so it disables every other Suggest button too.
        if (response.status === 429 && message.includes("today's limit")) {
          setDailyCapHit(message);
        }
        return;
      }

      const body = response.data;
      if (body.outcome === 'match') {
        setAiSuggestions((s) => ({ ...s, [transactionId]: body.categoryId }));
        return;
      }
      setAiResults((r) => ({
        ...r,
        [transactionId]: {
          message: 'No confident match — pick a category yourself.',
          tone: 'status',
        },
      }));
    } finally {
      setSuggestingId(null);
    }
  };

  /** Rendered only for rows no rule matched — AI is for the leftovers, and the
   * server refuses a rule-matched row anyway. */
  const renderSuggest = (transactionId: string, compact: boolean): React.ReactElement | null =>
    showSuggest ? (
      <SuggestAiButton
        compact={compact}
        state={suggestingId === transactionId ? 'loading' : 'idle'}
        disabledReason={dailyCapHit}
        onClick={() => void suggestAi(transactionId)}
      />
    ) : null;

  const renderAiResult = (transactionId: string): React.ReactElement | null => {
    const result = aiResults[transactionId];
    if (!result) return null;
    return (
      <p
        role={result.tone}
        className={cn(
          'mt-2 rounded-lg px-3 py-2 text-[12.5px]',
          result.tone === 'alert' ? 'bg-rose-soft text-rose' : 'border-line text-ink-muted border',
        )}
      >
        {result.message}
      </p>
    );
  };

  const matched = queue.filter((r) => r.suggestedCategoryId);

  // Grouped by payee for the batch-review default: rule-matched groups (a
  // one-tap win) sort first, then largest groups first within each bucket.
  const payeeGroups = useMemo<PayeeGroup[]>(() => {
    const map = new Map<string, CategorizeQueueRow[]>();
    for (const row of queue) {
      if (!map.has(row.payee)) map.set(row.payee, []);
      map.get(row.payee)!.push(row);
    }
    return Array.from(map.values())
      .map((rows) => ({
        payee: rows[0].payee,
        rows,
        totalAmount: rows.reduce((sum, r) => sum + Number(r.amount), 0),
        meta: rows[0].meta,
        suggestedCategoryId: rows[0].suggestedCategoryId,
        suggestedCategoryName: rows[0].suggestedCategoryName,
        why: rows[0].why,
      }))
      .sort((a, b) => {
        const aMatched = a.suggestedCategoryId ? 0 : 1;
        const bMatched = b.suggestedCategoryId ? 0 : 1;
        return aMatched !== bMatched ? aMatched - bMatched : b.rows.length - a.rows.length;
      });
  }, [queue]);

  const progressPct =
    progress.totalCount > 0
      ? Math.round((progress.categorizedCount / progress.totalCount) * 100)
      : 0;

  const removeRow = (id: string): void => {
    setQueue((q) => q.filter((r) => r.id !== id));
  };

  const confirm = async (row: CategorizeQueueRow, categoryId: string): Promise<void> => {
    setPending(true);
    await patchCategory(row.id, categoryId);
    setPending(false);
    removeRow(row.id);
    router.refresh();
  };

  const skip = async (row: CategorizeQueueRow): Promise<void> => {
    setPending(true);
    await skipTransaction(row.id);
    setPending(false);
    removeRow(row.id);
    router.refresh();
  };

  const acceptAll = async (): Promise<void> => {
    const accepted = matched;
    setPending(true);
    await Promise.all(accepted.map((r) => patchCategory(r.id, r.suggestedCategoryId!)));
    setPending(false);
    setQueue((q) => q.filter((r) => !r.suggestedCategoryId));
    router.refresh();
    setToast({
      message: `Categorized ${accepted.length} transaction${accepted.length === 1 ? '' : 's'}`,
      undo: () => {
        void Promise.all(accepted.map((r) => patchCategory(r.id, null))).then(() => {
          setQueue((q) => [...accepted, ...q]);
          router.refresh();
        });
        setToast(null);
      },
    });
  };

  const confirmGroup = async (group: PayeeGroup, categoryId: string): Promise<void> => {
    setPending(true);
    await Promise.all(group.rows.map((r) => patchCategory(r.id, categoryId)));
    setPending(false);
    const removedIds = new Set(group.rows.map((r) => r.id));
    setQueue((q) => q.filter((r) => !removedIds.has(r.id)));
    router.refresh();
    setToast({
      message: `Categorized ${group.rows.length} transaction${group.rows.length === 1 ? '' : 's'}`,
      undo: () => {
        void Promise.all(group.rows.map((r) => patchCategory(r.id, null))).then(() => {
          setQueue((q) => [...group.rows, ...q]);
          router.refresh();
        });
        setToast(null);
      },
    });
  };

  const reviewGroupIndividually = (): void => {
    setReviewOne(true);
  };

  const visibleRows = queue;

  if (queue.length === 0) {
    return (
      <div className="mt-6">
        <div className="border-line bg-paper-raised rounded-[18px] border p-10 text-center">
          <p className="text-ink-muted text-sm">Nothing left to categorize. Nice.</p>
        </div>
        <AnimatePresence>
          {toast && (
            <Toast message={toast.message} onUndo={toast.undo} onDismiss={() => setToast(null)} />
          )}
        </AnimatePresence>
      </div>
    );
  }

  return (
    <div className="mt-6">
      <div className="bg-paper-sunk flex gap-1 rounded-full p-1">
        <button
          type="button"
          onClick={() => setReviewOne(false)}
          className={cn(
            'flex-1 rounded-full py-2.5 text-[13.5px] font-semibold',
            !reviewOne ? 'bg-paper-raised text-ink shadow-sm' : 'text-ink-muted font-medium',
          )}
        >
          By payee · {payeeGroups.length}
        </button>
        <button
          type="button"
          onClick={() => setReviewOne(true)}
          className={cn(
            'flex-1 rounded-full py-2.5 text-[13.5px] font-semibold',
            reviewOne ? 'bg-paper-raised text-ink shadow-sm' : 'text-ink-muted font-medium',
          )}
        >
          One by one
        </button>
      </div>

      <div className="mt-4 flex items-baseline justify-between gap-2 text-xs">
        <span className="text-ink-muted">
          {progress.categorizedCount} of {progress.totalCount} categorized
        </span>
        <span className="font-mono">{progressPct}%</span>
      </div>
      <div className="bg-paper-sunk mt-1.5 h-1.5 overflow-hidden rounded-full">
        <div
          className="bg-iris h-full rounded-full transition-[width]"
          style={{ width: `${progressPct}%` }}
        />
      </div>

      {reviewOne ? (
        matched.length > 0 && (
          <div className="mt-4 flex justify-end">
            <Button
              type="button"
              onClick={acceptAll}
              icon={CheckCheck}
              loading={pending}
              className="px-4 py-2 text-[13.5px]"
            >
              Accept all {matched.length} match{matched.length === 1 ? '' : 'es'}
            </Button>
          </div>
        )
      ) : (
        <div className="relative mt-5 flex flex-col gap-3">
          <AnimatePresence mode="popLayout" initial={false}>
            {payeeGroups.slice(0, visibleGroupCount).map((group) => {
              const showMore = groupMore[group.payee] ?? false;
              const chipCategories = showMore ? categories : categories.slice(0, 3);
              // An AI suggestion lands here exactly like a chip tap would: it
              // pre-selects, it does not apply. "Categorize all N" is still the
              // user's explicit accept.
              const chosenId = groupChoice[group.payee] ?? aiSuggestions[group.rows[0].id] ?? null;
              return (
                <m.div
                  key={group.payee}
                  {...listItemMotion}
                  data-testid="payee-group-card"
                  className="border-line bg-paper-raised rounded-[18px] border p-4"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate text-base font-semibold tracking-[-0.01em]">
                        {group.payee}
                      </div>
                      <div className="text-ink-muted mt-0.5 text-xs">
                        {group.rows.length} transaction{group.rows.length === 1 ? '' : 's'} ·{' '}
                        {group.meta}
                      </div>
                    </div>
                    <span className="text-rose font-mono text-sm tabular-nums">
                      -{group.totalAmount.toFixed(2)}
                    </span>
                  </div>

                  {group.suggestedCategoryId ? (
                    <>
                      <div className="bg-paper mt-3.5 flex items-center gap-2 rounded-xl px-3 py-2.5">
                        <span className="bg-sky-soft text-sky rounded-full px-2 py-1 text-[10px] font-semibold tracking-[0.05em] uppercase">
                          Rule match
                        </span>
                        <span className="text-[13.5px] font-medium">
                          {group.suggestedCategoryName}
                        </span>
                      </div>
                      <button
                        type="button"
                        disabled={pending}
                        onClick={() => void confirmGroup(group, group.suggestedCategoryId!)}
                        className="bg-iris text-paper-raised mt-3 block w-full rounded-full py-2.75 text-[14.5px] font-semibold disabled:opacity-50"
                      >
                        Categorize all {group.rows.length} as {group.suggestedCategoryName}
                      </button>
                      <div className="mt-3.5 flex items-start gap-2.5">
                        <span className="bg-iris mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-md">
                          <Check size={12} className="text-paper-raised" strokeWidth={2.5} />
                        </span>
                        <span className="text-ink-muted text-[12.5px] leading-snug">
                          Keeps matching future {group.payee} imports to{' '}
                          {group.suggestedCategoryName} automatically.
                        </span>
                      </div>
                      <button
                        type="button"
                        onClick={() => reviewGroupIndividually()}
                        className="text-iris mt-3 block w-full py-2 text-center text-[13px] font-medium"
                      >
                        Review these {group.rows.length} individually
                      </button>
                    </>
                  ) : (
                    <>
                      <p className="text-ink-muted mt-2.5 text-[12.5px] leading-snug">
                        {group.why ?? 'No rule matches this payee. Pick a category for the batch.'}
                      </p>
                      <div className="mt-3 flex flex-wrap items-center gap-2">
                        {renderSuggest(group.rows[0].id, false)}
                      </div>
                      {renderAiResult(group.rows[0].id)}
                      <div className="mt-3.5 flex flex-wrap gap-2">
                        {chipCategories.map((c) => (
                          <button
                            key={c.id}
                            type="button"
                            onClick={() => setGroupChoice((g) => ({ ...g, [group.payee]: c.id }))}
                            className={cn(
                              'rounded-full border px-3.5 py-2 text-[13.5px]',
                              chosenId === c.id
                                ? 'border-iris bg-iris-soft text-iris font-medium'
                                : 'border-line text-ink',
                            )}
                          >
                            {c.name}
                          </button>
                        ))}
                        {!showMore && categories.length > 3 && (
                          <button
                            type="button"
                            onClick={() => setGroupMore((g) => ({ ...g, [group.payee]: true }))}
                            className="border-line text-ink-muted rounded-full border px-3.5 py-2 text-[13.5px]"
                          >
                            More…
                          </button>
                        )}
                      </div>
                      <div className="mt-3.5 flex gap-2.5">
                        <button
                          type="button"
                          onClick={() => reviewGroupIndividually()}
                          className="border-line text-ink flex-1 rounded-full border py-3 text-[13.5px] font-medium"
                        >
                          Split individually
                        </button>
                        <button
                          type="button"
                          disabled={!chosenId || pending}
                          onClick={() => chosenId && void confirmGroup(group, chosenId)}
                          className="bg-iris text-paper-raised flex-[1.2] rounded-full py-3 text-[13.5px] font-semibold disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          Categorize all {group.rows.length}
                        </button>
                      </div>
                    </>
                  )}
                </m.div>
              );
            })}
          </AnimatePresence>
          {visibleGroupCount < payeeGroups.length && (
            <button
              type="button"
              onClick={() => setVisibleGroupCount((n) => n + GROUP_PAGE_SIZE)}
              className="border-line text-ink rounded-full border py-3 text-[13.5px] font-medium"
            >
              Show {Math.min(GROUP_PAGE_SIZE, payeeGroups.length - visibleGroupCount)} more of{' '}
              {payeeGroups.length - visibleGroupCount} remaining
            </button>
          )}
        </div>
      )}

      {/* Desktop: table-style rows with a category dropdown — plenty of
          width for a fixed-column layout. Only rendered in "one by one" mode;
          the default "by payee" mode uses the grouped batch cards above. */}
      <div
        className={cn(
          'border-line bg-paper-raised relative mt-4 rounded-[18px] border px-6',
          reviewOne ? 'hidden lg:block' : 'hidden',
        )}
      >
        <AnimatePresence mode="popLayout" initial={false}>
          {visibleRows.map((row) => {
            const aiChoice = aiSuggestions[row.id] ?? null;
            return (
              <m.div key={row.id} {...listItemMotion} className="ledger-row py-4.5">
                <div className="flex items-center gap-5">
                  <div className="w-[230px] min-w-0 shrink-0">
                    <div className="truncate text-sm font-medium">{row.payee}</div>
                    <div className="text-ink-muted mt-0.5 text-xs">{row.meta}</div>
                  </div>
                  <span className="text-rose w-24 shrink-0 text-right font-mono text-sm tabular-nums">
                    -{row.amount}
                  </span>
                  <div className="text-ink-muted w-[250px] shrink-0 text-[12.5px] leading-snug">
                    {row.why ?? 'No rule matches this transaction.'}
                  </div>
                  <div className="ml-auto flex shrink-0 items-center gap-1.5">
                    {!row.suggestedCategoryId && renderSuggest(row.id, true)}
                    {/* Controlled, so an AI suggestion has somewhere to land
                    before it is accepted — exactly how a rule match already
                    pre-fills it. Picking any option still applies
                    immediately; there is no separate confirm step. */}
                    <Select
                      disabled={pending}
                      className="border-line bg-paper rounded-full px-3 py-2 text-sm"
                      onChange={(e) => {
                        if (e.target.value) void confirm(row, e.target.value);
                      }}
                      value={aiChoice ?? row.suggestedCategoryId ?? ''}
                    >
                      {!row.suggestedCategoryId && !aiChoice && (
                        <option value="" disabled>
                          Choose category
                        </option>
                      )}
                      {categories.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </Select>
                    {/* Only exists while an unaccepted AI suggestion is sitting in
                    the select — re-picking the value already selected fires no
                    change event, so without this the row would have no way to
                    accept it. */}
                    {aiChoice && (
                      <Button
                        type="button"
                        onClick={() => void confirm(row, aiChoice)}
                        icon={Check}
                        loading={pending}
                        className="px-3 py-2 text-[13px]"
                      >
                        Apply
                      </Button>
                    )}
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={() => void skip(row)}
                      icon={SkipForward}
                      loading={pending}
                      className="px-3 py-2 text-[13px]"
                    >
                      Skip
                    </Button>
                  </div>
                </div>
                {renderAiResult(row.id)}
              </m.div>
            );
          })}
        </AnimatePresence>
      </div>

      {/* Mobile: one card, category chips instead of a dropdown — tapping a
          chip confirms immediately (no separate confirm step), so
          reassigning is a single tap. The rule's suggestion (if any) sorts
          first and gets an accent ring so it's the easiest chip to reach. */}
      <div className={cn('relative mt-4 flex flex-col gap-3', reviewOne ? 'lg:hidden' : 'hidden')}>
        <AnimatePresence mode="popLayout" initial={false}>
          {visibleRows.map((row) => {
            // A rule match wins the top slot; an AI suggestion takes it otherwise,
            // so the accent chip always means "the suggestion for this row".
            const highlightId = row.suggestedCategoryId ?? aiSuggestions[row.id] ?? null;
            const sortedCategories = highlightId
              ? [
                  ...categories.filter((c) => c.id === highlightId),
                  ...categories.filter((c) => c.id !== highlightId),
                ]
              : categories;
            return (
              <m.div
                key={row.id}
                {...listItemMotion}
                data-testid="categorize-card-mobile"
                className="border-line bg-paper-raised flex flex-col gap-4 rounded-[18px] border p-5"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate text-[15px] font-medium">{row.payee}</div>
                    <div className="text-ink-muted mt-0.5 text-xs">{row.meta}</div>
                  </div>
                  <span className="text-rose shrink-0 font-mono text-base tabular-nums">
                    -{row.amount}
                  </span>
                </div>
                <p className="text-ink-muted text-[12.5px] leading-snug">
                  {row.why ?? 'No rule matches this transaction.'}
                </p>
                {!row.suggestedCategoryId && (
                  <div className="flex flex-wrap items-center gap-2">
                    {renderSuggest(row.id, false)}
                  </div>
                )}
                {renderAiResult(row.id)}
                <div className="flex flex-wrap gap-2">
                  {sortedCategories.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      disabled={pending}
                      onClick={() => void confirm(row, c.id)}
                      className={cn(
                        'rounded-full border px-3.5 py-2 text-[13px] font-medium disabled:opacity-50',
                        c.id === highlightId
                          ? 'border-iris bg-iris-soft text-iris'
                          : 'border-line text-ink',
                      )}
                    >
                      {c.name}
                    </button>
                  ))}
                </div>
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => void skip(row)}
                  icon={SkipForward}
                  loading={pending}
                  className="justify-center py-2.5 text-[13px]"
                >
                  Skip
                </Button>
              </m.div>
            );
          })}
        </AnimatePresence>
      </div>

      <AnimatePresence>
        {toast && (
          <Toast message={toast.message} onUndo={toast.undo} onDismiss={() => setToast(null)} />
        )}
      </AnimatePresence>
    </div>
  );
};
