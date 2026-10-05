'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { AnimatePresence, m } from 'framer-motion';
import {
  ArrowLeftRight,
  HandCoins,
  Loader2,
  Plus,
  Search,
  SlidersHorizontal,
  Trash2,
  Upload,
} from 'lucide-react';
import { Drawer } from '@/components/ui/drawer';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Money } from '@/components/ui/money';
import { TransactionTotals } from '@/components/transactions/transaction-totals';
import { TransactionForm } from '@/components/transactions/transaction-form';
import { AddTransactionLink } from '@/components/transactions/add-transaction-link';
import { TransactionFiltersDialog } from '@/components/transactions/transaction-filters-dialog';
import { MatchTransfersDialog } from '@/components/transactions/match-transfers-dialog';
import { StatementPicker } from '@/components/transactions/period-picker';
import { deleteJSON, getJSON, postJSON, type ApiFailure } from '@/lib/api-client';
import { cn } from '@/lib/cn';
import { listItemMotion } from '@/lib/motion/tokens';
import { useAnimateListChange } from '@/lib/motion/use-animate-list-change';
import {
  countActiveFilterGroups,
  parseTransactionFilters,
  transactionFiltersToSearchParams,
  type TransactionFilters,
} from '@/lib/transactions/transaction-filters';
import type { TransactionSummary } from '@/lib/transactions/transaction-summary';
import {
  transactionsPageSearchParams,
  transactionsPageUrl,
} from '@/lib/transactions/transactions-page-query';
import type { FrontendAccount } from '@/lib/services/accounts';
import type { FrontendCategory } from '@/lib/services/categories';
import type { FrontendTransaction } from '@/lib/services/transactions';
import type { TransactionsPageResult } from '@/lib/services/transactionsPage';
import { formatDate } from '@/lib/format';
import { categoryColorVar } from '@/lib/ui/category-color';

const toCents = (value: string | number): number => Math.round(Number(value) * 100);

/** The quick pills are shortcuts into the same `type` / `uncategorizedOnly`
 * filters the dialog edits, so the two can never disagree. A combination the
 * pills can't express (set from the dialog) leaves no pill highlighted. */
/** Mobile pills: presets of the `type`/`uncategorizedOnly` filters. */
type QuickFilter = 'all' | 'uncategorized' | 'spending' | 'income';

const QUICK_FILTERS: Record<QuickFilter, Pick<TransactionFilters, 'type' | 'uncategorizedOnly'>> = {
  all: { type: null, uncategorizedOnly: false },
  uncategorized: { type: null, uncategorizedOnly: true },
  spending: { type: 'EXPENSE', uncategorizedOnly: false },
  income: { type: 'INCOME', uncategorizedOnly: false },
};

const activeQuickFilter = (filters: TransactionFilters): QuickFilter | null =>
  (Object.keys(QUICK_FILTERS) as QuickFilter[]).find(
    (key) =>
      QUICK_FILTERS[key].type === filters.type &&
      QUICK_FILTERS[key].uncategorizedOnly === filters.uncategorizedOnly,
  ) ?? null;

const toTotals = (
  summary: TransactionsPageResult['summary'],
  count: number,
): TransactionSummary => ({
  count,
  credit: Number(summary.credit),
  debit: Number(summary.debit),
  net: Number(summary.net),
  payments: Number(summary.payments),
  transfers: Number(summary.transfers),
  reimbursementIncome: Number(summary.reimbursementIncome),
});

/** Groups by UTC day; a page that lands mid-day appends to the existing group. */
const groupByDay = (list: FrontendTransaction[]): [string, FrontendTransaction[]][] => {
  const groups = new Map<string, FrontendTransaction[]>();
  for (const t of list) {
    const key = t.date.slice(0, 10);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(t);
  }
  return Array.from(groups.entries());
};

/** A 400 must not be retried as-is; `network` errors retry the same request. */
type FetchErrorKind = 'invalid-request' | 'network';
const classifyFailure = (res: ApiFailure): FetchErrorKind =>
  res.status === 400 ? 'invalid-request' : 'network';

type Tree = 'desktop' | 'mobile';

const plural = (n: number): string => (n === 1 ? '' : 's');

/** Scope part of a request key (`<scope query>#<reloadNonce>`). */
const scopeOf = (requestKey: string): string => requestKey.slice(0, requestKey.lastIndexOf('#'));

export const TransactionsView = ({
  initialPage,
  initialRequestKey,
  accounts,
  categories,
}: {
  initialPage: TransactionsPageResult;
  initialRequestKey: string;
  accounts: FrontendAccount[];
  categories: FrontendCategory[];
}): React.ReactElement => {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [dialogKey, setDialogKey] = useState(0);
  const [open, setOpen] = useState(false);
  const [drawerKey, setDrawerKey] = useState(0);
  // `?tx=<id>` opens that row's drawer; the link is scoped to its day, so it's on page 1.
  const [detail, setDetail] = useState<FrontendTransaction | null>(() => {
    const id = searchParams.get('tx');
    return id ? (initialPage.rows.find((t) => t.id === id) ?? null) : null;
  });
  // Separate from `detail` so the drawer keeps showing the transaction while
  // it animates closed, instead of emptying out mid-exit.
  const [detailOpen, setDetailOpen] = useState(() => detail !== null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deletePending, setDeletePending] = useState(false);
  const [matchPending, setMatchPending] = useState(false);
  const [matchResult, setMatchResult] = useState<string | null>(null);
  const [mobileSearch, setMobileSearch] = useState('');
  const [filtersDialogOpen, setFiltersDialogOpen] = useState(false);
  const [filtersDialogKey, setFiltersDialogKey] = useState(0);
  const [matchDialogOpen, setMatchDialogOpen] = useState(false);
  const [matchDialogKey, setMatchDialogKey] = useState(0);

  // Loaded pages for `pagesKey`. Key = `<scope query>#<reloadNonce>`; mutations bump the nonce.
  const [pages, setPages] = useState<TransactionsPageResult[]>([initialPage]);
  const [pagesKey, setPagesKey] = useState(`${initialRequestKey}#0`);
  const [reloadNonce, setReloadNonce] = useState(0);
  const [scopeError, setScopeError] = useState<{ key: string; kind: FetchErrorKind } | null>(null);
  const [scopeRetry, setScopeRetry] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<FetchErrorKind | null>(null);
  const [announcements, setAnnouncements] = useState<Record<Tree, string>>({
    desktop: '',
    mobile: '',
  });
  const pagesKeyRef = useRef(pagesKey);
  const desktopListRef = useRef<HTMLDivElement>(null);
  const mobileListRef = useRef<HTMLDivElement>(null);
  const desktopStatusRef = useRef<HTMLParagraphElement>(null);
  const mobileStatusRef = useRef<HTMLParagraphElement>(null);
  const desktopLoadMoreRef = useRef<HTMLDivElement>(null);
  const mobileLoadMoreRef = useRef<HTMLDivElement>(null);

  // The SSR page is adopted on mount; the client fetches after that. A server
  // re-render with the same scope but a changed page 1 means a mutation elsewhere
  // called `router.refresh()`, so refetch. Identical or new-scope re-renders are ignored.
  const [ssrSeen, setSsrSeen] = useState(() => ({
    page: initialPage,
    key: initialRequestKey,
    signature: JSON.stringify(initialPage),
  }));
  if (initialPage !== ssrSeen.page) {
    const signature = JSON.stringify(initialPage);
    setSsrSeen({ page: initialPage, key: initialRequestKey, signature });
    if (initialRequestKey === ssrSeen.key && signature !== ssrSeen.signature) {
      setReloadNonce((n) => n + 1);
    }
  }

  // The URL is the source of truth for every filter except the payee search
  // box (below) — re-derived on every searchParams change rather than
  // mirrored into separate component state, so there's one place filter
  // state can drift from the URL: nowhere.
  const filters = useMemo(() => parseTransactionFilters(searchParams), [searchParams]);
  const activeFilterCount = countActiveFilterGroups(filters);

  // Payee search settles after 300ms, then goes into the request and the URL.
  const [payeeDraft, setPayeeDraft] = useState(filters.payee);
  const [settledPayee, setSettledPayee] = useState(filters.payee);
  // Re-seeds `payeeDraft` when `filters.payee` changes from outside this
  // input (the filters dialog's "Reset", browser back/forward, a pasted
  // URL) — adjusted during render, React's documented pattern for syncing
  // state to a prop change, rather than in an effect (which would commit
  // the stale draft for one extra frame first).
  const [payeeSyncedFrom, setPayeeSyncedFrom] = useState(filters.payee);
  // Payee values we pushed to the URL that it hasn't reflected yet. Their echo
  // must not overwrite what the user has typed since. A queue, since several can be in flight.
  const [pendingPayeePushes, setPendingPayeePushes] = useState<string[]>([]);
  if (filters.payee !== payeeSyncedFrom) {
    setPayeeSyncedFrom(filters.payee);
    const echoAt = pendingPayeePushes.indexOf(filters.payee);
    if (echoAt >= 0) {
      setPendingPayeePushes(pendingPayeePushes.slice(echoAt + 1));
    } else {
      setPayeeDraft(filters.payee);
      setSettledPayee(filters.payee);
      setPendingPayeePushes([]);
    }
  }
  // The URL's payee once our pending pushes land; the debounce compares against this.
  const payeeUrlTargetRef = useRef(filters.payee);
  useEffect(() => {
    if (pendingPayeePushes.length === 0) payeeUrlTargetRef.current = filters.payee;
  }, [filters.payee, pendingPayeePushes]);

  // History API, not `router.replace`: the view fetches its own page, so a server render is wasted.
  const pushFilters = useCallback(
    (next: TransactionFilters): void => {
      const query = transactionFiltersToSearchParams(next).toString();
      window.history.replaceState(null, '', query ? `${pathname}?${query}` : pathname);
    },
    [pathname],
  );

  useEffect(() => {
    if (payeeDraft === settledPayee) return;
    const timeout = setTimeout(() => {
      setSettledPayee(payeeDraft);
      if (payeeDraft === payeeUrlTargetRef.current) return;
      payeeUrlTargetRef.current = payeeDraft;
      setPendingPayeePushes((pushes) => [...pushes, payeeDraft]);
      pushFilters({ ...filters, payee: payeeDraft });
    }, 300);
    return () => clearTimeout(timeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only re-run on payeeDraft changes; `filters`/`pushFilters` reacting here would restart the debounce on every unrelated filter change
  }, [payeeDraft]);

  // Same 300ms settle for mobile search.
  const [settledMobileSearch, setSettledMobileSearch] = useState('');
  useEffect(() => {
    if (mobileSearch === settledMobileSearch) return;
    const timeout = setTimeout(() => setSettledMobileSearch(mobileSearch), 300);
    return () => clearTimeout(timeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- debounce keystrokes only; the settled value changing must not restart it
  }, [mobileSearch]);

  const selectedAccountId = filters.accountIds.length === 1 ? filters.accountIds[0] : null;
  const selectedAccount = accounts.find((a) => a.id === selectedAccountId);
  const isCreditCard = selectedAccount?.type === 'CREDIT_CARD';
  const quickFilter = activeQuickFilter(filters);

  const openFiltersDialog = (): void => {
    setFiltersDialogKey((k) => k + 1);
    setFiltersDialogOpen(true);
  };

  const openCreate = (): void => {
    setDialogKey((k) => k + 1);
    setOpen(true);
  };

  const openDetail = (tx: FrontendTransaction): void => {
    setDetail(tx);
    setDetailOpen(true);
    setDrawerKey((k) => k + 1);
  };

  // Drops `?tx=` on close so a refresh or back navigation doesn't reopen it.
  const closeDetail = (): void => {
    setDetailOpen(false);
    const params = new URLSearchParams(window.location.search);
    if (!params.has('tx')) return;
    params.delete('tx');
    const query = params.toString();
    window.history.replaceState(null, '', query ? `${pathname}?${query}` : pathname);
  };

  const handleDelete = async (id: string): Promise<void> => {
    setDeletePending(true);
    await deleteJSON(`/api/transactions/${id}`);
    setDeletePending(false);
    setConfirmDeleteId(null);
    closeDetail();
    setReloadNonce((n) => n + 1);
    router.refresh();
  };

  const openMatchDialog = (): void => {
    setMatchDialogKey((k) => k + 1);
    setMatchDialogOpen(true);
  };

  const handleMatchTransfers = async (range: { from: Date; to: Date }): Promise<void> => {
    setMatchPending(true);
    setMatchResult(null);
    const res = await postJSON<{ matched: number }>('/api/transactions/match-transfers', range);
    setMatchPending(false);
    if (!res.ok) {
      setMatchResult('Could not match transfers. Try again.');
      return;
    }
    setMatchDialogOpen(false);
    const data = res.data;
    setMatchResult(
      data.matched === 0
        ? 'No new transfer pairs found.'
        : `Matched ${data.matched} transfer pair${data.matched === 1 ? '' : 's'}.`,
    );
    setReloadNonce((n) => n + 1);
    router.refresh();
  };

  const scopeKey = useMemo(
    () =>
      transactionsPageSearchParams({
        filters: { ...filters, payee: settledPayee },
        mobileSearch: settledMobileSearch,
      }).toString(),
    [filters, settledPayee, settledMobileSearch],
  );
  const requestKey = `${scopeKey}#${reloadNonce}`;
  // Page 1 for the current key is loading; old rows stay, dimmed.
  const pending = requestKey !== pagesKey && scopeError?.key !== requestKey;
  const currentScopeError = scopeError?.key === requestKey ? scopeError.kind : null;

  useEffect(() => {
    pagesKeyRef.current = pagesKey;
  }, [pagesKey]);

  // A new request key fetches page 1 and replaces `pages`; stale responses are dropped.
  useEffect(() => {
    if (requestKey === pagesKey) return;
    const key = requestKey;
    const scopeChanged = scopeOf(key) !== scopeOf(pagesKey);
    const controller = new AbortController();
    void getJSON<TransactionsPageResult>(transactionsPageUrl(scopeOf(key)), {
      signal: controller.signal,
    }).then((res) => {
      if (controller.signal.aborted) return;
      if (!res.ok) {
        setScopeError({ key, kind: classifyFailure(res) });
        return;
      }
      const page = res.data;
      setPages([page]);
      setPagesKey(key);
      setScopeError(null);
      setMoreError(null);
      setAnnouncements({
        desktop: `${page.rows.length} of ${page.desktopCount} shown.`,
        mobile: `${page.rows.length} of ${page.totalCount} shown.`,
      });
      if (scopeChanged) {
        // scroll to the top only if it's already scrolled past
        for (const el of [desktopListRef.current, mobileListRef.current]) {
          if (el && el.offsetParent !== null && el.getBoundingClientRect().top < 0) {
            el.scrollIntoView({ block: 'start' });
          }
        }
      }
    });
    return () => controller.abort();
    // `scopeRetry` lets "Try again" re-run the same key
  }, [requestKey, pagesKey, scopeRetry]);

  const retryScope = (): void => {
    setScopeError(null);
    setScopeRetry((n) => n + 1);
  };

  const lastPage = pages[pages.length - 1];
  const canLoadMore = !pending && requestKey === pagesKey && lastPage.hasMore;

  const loadMore = async (tree: Tree): Promise<void> => {
    if (moreError === 'invalid-request') {
      // cursor rejected: restart from page 1
      setMoreError(null);
      setReloadNonce((n) => n + 1);
      return;
    }
    const key = pagesKey;
    const cursor = lastPage.nextCursor;
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    setMoreError(null);
    const res = await getJSON<TransactionsPageResult>(transactionsPageUrl(scopeOf(key), cursor));
    setLoadingMore(false);
    if (pagesKeyRef.current !== key) return; // the scope moved on while this was in flight
    if (!res.ok) {
      setMoreError(classifyFailure(res));
      return;
    }
    const page = res.data;
    const rendered = pages.reduce((n, p) => n + p.rows.length, 0) + page.rows.length;
    setPages((prev) => [...prev, page]);
    const message = (count: number): string =>
      `Loaded ${page.rows.length} more transaction${plural(page.rows.length)}. ${rendered} of ${count} shown.`;
    setAnnouncements({
      desktop: message(pages[0].desktopCount),
      mobile: message(pages[0].totalCount),
    });
    // When the button unmounts, move focus to the status line instead of <body>.
    requestAnimationFrame(() => {
      const row = tree === 'desktop' ? desktopLoadMoreRef.current : mobileLoadMoreRef.current;
      const status = tree === 'desktop' ? desktopStatusRef.current : mobileStatusRef.current;
      if (page.hasMore) row?.querySelector('button')?.focus();
      else status?.focus();
    });
  };

  const { summary, mobileSummary, desktopCount, totalCount, uncategorizedCount } = pages[0];

  // Only depends on `pages`, so typing doesn't rebuild it.
  const { rows, dayTotals, runningBalance, days } = useMemo(() => {
    // Each page's day totals are full-day, so later pages overwrite.
    const dayTotals = new Map<string, number>();
    for (const page of pages) {
      for (const d of page.dayTotals) dayTotals.set(d.day, Number(d.total));
    }

    // Walk each page oldest-first from its server opening balance, in cents.
    const runningBalance = new Map<string, number>();
    for (const page of pages) {
      let cents = toCents(page.runningBalanceStart);
      for (let i = page.rows.length - 1; i >= 0; i--) {
        const t = page.rows[i];
        cents += t.type === 'INCOME' ? toCents(t.amount) : -toCents(t.amount);
        runningBalance.set(t.id, cents / 100);
      }
    }

    const rows = pages.flatMap((p) => p.rows);
    return { rows, dayTotals, runningBalance, days: groupByDay(rows) };
  }, [pages]);

  // A delete or a single edit animates; pagination, filters and search swap
  // rows instantly.
  const animateRows = useAnimateListChange(rows.map((t) => t.id));
  const rowMotion = {
    ...listItemMotion,
    layout: animateRows ? listItemMotion.layout : false,
    initial: animateRows ? listItemMotion.initial : false,
  } as const;

  const renderLoadMore = (tree: Tree): React.ReactElement => (
    <div
      ref={tree === 'desktop' ? desktopLoadMoreRef : mobileLoadMoreRef}
      className={tree === 'desktop' ? 'mt-5.5 flex flex-col items-center gap-2' : 'mt-5'}
    >
      {canLoadMore && (
        <>
          <Button
            type="button"
            variant="secondary"
            loading={loadingMore}
            onClick={() => void loadMore(tree)}
            className={tree === 'mobile' ? 'w-full py-3' : undefined}
          >
            {moreError ? 'Try again' : 'Load more'}
          </Button>
          {moreError && (
            <p role="alert" className="text-rose mt-2 text-center text-[13px]">
              Couldn&apos;t load more transactions. Try again.
            </p>
          )}
        </>
      )}
      <p
        ref={tree === 'desktop' ? desktopStatusRef : mobileStatusRef}
        tabIndex={-1}
        role="status"
        aria-live="polite"
        data-testid={`transactions-load-status-${tree}`}
        className="sr-only"
      >
        {announcements[tree]}
      </p>
    </div>
  );

  const renderScopeError = (): React.ReactElement | null =>
    currentScopeError ? (
      <div role="alert" className="text-rose mt-3 flex items-center gap-3 text-[13px]">
        <span>Couldn&apos;t load transactions. Try again.</span>
        <Button type="button" variant="secondary" onClick={retryScope} className="px-3 py-1">
          Try again
        </Button>
      </div>
    ) : null;

  const SearchIcon = pending ? Loader2 : Search;
  const searchIconClass = cn('text-ink-muted shrink-0', pending && 'animate-spin');
  return (
    <div className="mt-6.5 pb-20 lg:pb-0">
      {/* Desktop-only filter row; the mobile screen gets its own search +
          quick-filter pills below, matching the mockup. */}
      <div
        data-testid="transaction-filters-desktop"
        className="hidden items-center gap-2 lg:flex lg:flex-wrap"
      >
        <div
          data-testid="transactions-search-desktop"
          data-pending={pending ? 'true' : 'false'}
          className="border-line bg-paper-raised flex shrink-0 items-center gap-2 rounded-full border px-3.5 py-2"
        >
          <SearchIcon size={15} className={searchIconClass} aria-hidden="true" />
          <input
            type="text"
            value={payeeDraft}
            onChange={(e) => setPayeeDraft(e.target.value)}
            placeholder="Search payee"
            className="placeholder:text-ink-muted/70 w-36 bg-transparent text-[13px] outline-none"
          />
        </div>
        <Button
          type="button"
          variant="secondary"
          onClick={openFiltersDialog}
          icon={SlidersHorizontal}
          className="shrink-0 px-4 py-2"
        >
          Filters
          {activeFilterCount > 0 && (
            <span className="bg-iris text-paper-raised rounded-full px-1.5 py-0.5 font-mono text-[11px] tabular-nums">
              {activeFilterCount}
            </span>
          )}
        </Button>
        <div className="hidden flex-1 lg:block" />
        <Link
          href="/import"
          className="border-line text-ink inline-flex shrink-0 items-center gap-1.5 rounded-full border px-4 py-2 text-sm"
        >
          <Upload size={15} />
          Import CSV
        </Link>
        <Button
          type="button"
          variant="secondary"
          onClick={openMatchDialog}
          icon={ArrowLeftRight}
          loading={matchPending}
          className="shrink-0 px-4 py-2"
        >
          Match transfers
        </Button>
        {/* Desktop-only: below lg the sticky "+ Log a spend" CTA already covers
            this screen, and a second entry point crowds the filter row.
            Visibility lives on a wrapper, not the Button's className — `cn` is
            a plain join, so `hidden` would sit alongside the Button's own base
            `inline-flex` rather than overriding it. */}
        <div className="hidden shrink-0 lg:block">
          <Button type="button" onClick={openCreate} icon={Plus} className="px-4 py-2">
            Add transaction
          </Button>
        </div>
      </div>

      {matchResult && (
        <p className="text-ink-muted mt-2 text-sm" role="status">
          {matchResult}
        </p>
      )}

      {isCreditCard && (
        <div className="mt-3">
          {selectedAccount.statementDay ? (
            <StatementPicker
              statementDay={selectedAccount.statementDay}
              range={{ from: filters.from, to: filters.to }}
              onSelect={(range) => pushFilters({ ...filters, ...range })}
            />
          ) : (
            <p className="text-ink-muted text-xs">
              Set a statement day on this account to view by statement.
            </p>
          )}
        </div>
      )}

      <div
        data-testid="transactions-summary"
        aria-busy={pending}
        className={cn('mt-3.5 hidden transition-opacity lg:block', pending && 'opacity-60')}
      >
        <TransactionTotals summary={toTotals(summary, desktopCount)} />
      </div>

      <div className="hidden lg:block">{renderScopeError()}</div>

      <div
        ref={desktopListRef}
        data-testid="transactions-list-desktop"
        aria-busy={pending}
        className={cn(
          'relative hidden transition-opacity lg:block',
          pending && 'pointer-events-none opacity-60',
        )}
      >
        {rows.length === 0 ? (
          <p className="text-ink-muted mt-6 text-sm">
            No transactions match. Log one to get started.
          </p>
        ) : (
          <AnimatePresence mode="popLayout" initial={false} custom={animateRows}>
            {days.map(([day, dayRows]) => {
              const dayTotal = dayTotals.get(day) ?? 0;
              return (
                <m.div
                  key={day}
                  {...rowMotion}
                  className="mt-5.5"
                  data-testid="transaction-day-desktop"
                >
                  <div className="flex items-baseline gap-3 px-0.5 pb-2">
                    <span className="text-ink-muted font-mono text-xs tracking-[0.06em]">
                      {formatDate(day)}
                    </span>
                    <span className="bg-line h-px flex-1" />
                    <span
                      data-testid="transaction-day-total"
                      className={cn('font-mono text-xs', dayTotal >= 0 ? 'text-sky' : 'text-rose')}
                    >
                      {dayTotal >= 0 ? '+' : '−'}
                      {Math.abs(dayTotal).toFixed(2)}
                    </span>
                  </div>
                  <div className="border-line bg-paper-raised relative rounded-[14px] border px-6">
                    <AnimatePresence mode="popLayout" initial={false} custom={animateRows}>
                      {dayRows.map((t) => (
                        <m.div
                          key={t.id}
                          {...rowMotion}
                          onClick={() => openDetail(t)}
                          className="ledger-row flex cursor-pointer items-center gap-3 py-3.5 lg:gap-5"
                        >
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-sm font-medium">
                              {t.payee || t.categoryName || 'Transaction'}
                            </div>
                            <div className="text-ink-muted mt-0.5 text-xs">{t.accountName}</div>
                            {/* non-interactive chip: the row already owns the click
                          (opens the detail drawer). The link to the history
                          entry lives in that drawer instead. */}
                            {t.importBatchFilename && (
                              <div className="text-ink-muted mt-0.5 flex items-center gap-1 text-[11px]">
                                <Upload size={11} />
                                <span className="truncate">{t.importBatchFilename}</span>
                              </div>
                            )}
                            {t.isReimbursable && (
                              <div className="text-ink-muted mt-0.5 flex items-center gap-1 text-[11px]">
                                <HandCoins size={11} />
                                {t.reimbursementStatus === 'COMPLETE' ? (
                                  <span>Reimbursable · reimbursed</span>
                                ) : (
                                  <span className="flex items-center gap-1">
                                    Reimbursable ·{' '}
                                    <Money
                                      value={t.reimbursementOutstanding}
                                      tone="neutral"
                                      className="text-[11px]"
                                    />{' '}
                                    pending
                                  </span>
                                )}
                              </div>
                            )}
                          </div>
                          <span
                            className={cn(
                              'shrink-0 rounded-full px-2.5 py-1 text-[12.5px]',
                              t.categoryName
                                ? 'border-line text-ink-muted border'
                                : 'border-rose bg-rose-soft text-rose border',
                            )}
                          >
                            {t.categoryName ?? 'Uncategorized'}
                          </span>
                          <span
                            className={cn(
                              'shrink-0 text-right font-mono text-sm tabular-nums lg:w-[100px]',
                              t.type === 'INCOME' ? 'text-sky' : 'text-rose',
                            )}
                          >
                            {t.type === 'INCOME' ? '+' : '−'}
                            {Number(t.amount).toFixed(2)}
                          </span>
                          {/* Running balance is a desktop-only column: at 402px it squeezed
                        the payee cell to zero width. */}
                          <span
                            data-testid="running-balance"
                            className="text-ink-muted hidden w-[86px] shrink-0 text-right font-mono text-xs tabular-nums lg:block"
                          >
                            {(runningBalance.get(t.id) ?? 0).toFixed(2)}
                          </span>
                        </m.div>
                      ))}
                    </AnimatePresence>
                  </div>
                </m.div>
              );
            })}
          </AnimatePresence>
        )}
        {renderLoadMore('desktop')}
      </div>

      <div className="lg:hidden">
        <div className="flex items-center gap-2">
          <div
            data-testid="transactions-search-mobile"
            data-pending={pending ? 'true' : 'false'}
            className="border-line bg-paper-raised flex flex-1 items-center gap-2.25 rounded-full border px-3.75 py-0"
          >
            <SearchIcon size={15} className={searchIconClass} aria-hidden="true" />
            <input
              type="text"
              value={mobileSearch}
              onChange={(e) => setMobileSearch(e.target.value)}
              placeholder="Search payee or amount"
              className="placeholder:text-ink-muted/70 min-h-[46px] flex-1 bg-transparent text-sm outline-none"
            />
          </div>
          <button
            type="button"
            onClick={openFiltersDialog}
            aria-label="Filters"
            data-testid="mobile-filters-button"
            className="border-line bg-paper-raised text-ink relative flex h-[46px] w-[46px] shrink-0 items-center justify-center rounded-full border"
          >
            <SlidersHorizontal size={17} />
            {activeFilterCount > 0 && (
              <span className="bg-iris text-paper-raised absolute -top-1 -right-1 flex h-4.5 min-w-4.5 items-center justify-center rounded-full px-1 font-mono text-[10px] tabular-nums">
                {activeFilterCount}
              </span>
            )}
          </button>
        </div>

        <div
          data-testid="transaction-filters"
          className="-mx-4.5 mt-3 flex gap-2 overflow-x-auto px-4.5 pb-0.5"
        >
          {(
            [
              ['all', 'All'],
              ['uncategorized', `Uncategorized ${uncategorizedCount}`],
              ['spending', 'Spending'],
              ['income', 'Income'],
            ] as [QuickFilter, string][]
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => pushFilters({ ...filters, ...QUICK_FILTERS[key] })}
              className={cn(
                'shrink-0 rounded-full px-3.5 py-2 text-[12.5px] font-medium',
                quickFilter === key
                  ? 'bg-ink text-paper-raised'
                  : 'border-line text-ink bg-paper-raised border',
              )}
            >
              {label}
            </button>
          ))}
        </div>

        <TransactionTotals
          summary={toTotals(mobileSummary, totalCount)}
          className={cn('mt-3.5 transition-opacity', pending && 'opacity-60')}
        />

        {renderScopeError()}

        <div
          ref={mobileListRef}
          data-testid="transactions-list-mobile"
          aria-busy={pending}
          className={cn('relative transition-opacity', pending && 'pointer-events-none opacity-60')}
        >
          {rows.length === 0 ? (
            <p className="text-ink-muted mt-6 text-sm">
              No transactions match. Log one to get started.
            </p>
          ) : (
            <AnimatePresence mode="popLayout" initial={false} custom={animateRows}>
              {days.map(([day, dayRows]) => {
                const dayTotal = dayTotals.get(day) ?? 0;
                return (
                  <m.div key={day} {...rowMotion} className="mt-5">
                    <div className="flex items-baseline justify-between gap-2.5 px-0.5 pb-2">
                      <span className="text-ink-muted text-[11px] font-semibold tracking-[0.06em] uppercase">
                        {formatDate(day)}
                      </span>
                      <Money
                        value={dayTotal}
                        tone={dayTotal >= 0 ? 'income' : 'expense'}
                        className="text-[11.5px]"
                      />
                    </div>
                    <div className="relative flex flex-col gap-2">
                      <AnimatePresence mode="popLayout" initial={false} custom={animateRows}>
                        {dayRows.map((t) => (
                          <m.div
                            key={t.id}
                            {...rowMotion}
                            data-testid="transaction-row-mobile"
                            onClick={() => openDetail(t)}
                            className="border-line bg-paper-raised cursor-pointer rounded-2xl border p-3.5"
                          >
                            <div className="flex items-baseline justify-between gap-3">
                              <span className="truncate text-[15.5px] font-semibold tracking-[-0.01em]">
                                {t.payee || t.categoryName || 'Transaction'}
                              </span>
                              <Money
                                value={t.amount}
                                tone={t.type === 'INCOME' ? 'income' : 'expense'}
                                className="shrink-0 text-[15.5px]"
                              />
                            </div>
                            <div className="mt-2.5 flex items-center justify-between gap-2.5">
                              <span className="text-ink-muted min-w-0 truncate text-xs">
                                {t.accountName}
                              </span>
                              {t.categoryName ? (
                                <span
                                  className="shrink-0 rounded-full px-2.75 py-1 text-xs font-medium"
                                  style={{
                                    background: `color-mix(in srgb, ${categoryColorVar(t.categoryName)} 20%, var(--paper-raised))`,
                                    color: categoryColorVar(t.categoryName),
                                  }}
                                >
                                  {t.categoryName}
                                </span>
                              ) : (
                                <span className="border-line bg-paper text-ink-muted shrink-0 rounded-full border border-dashed px-2.75 py-1.5 text-xs font-medium">
                                  Uncategorized
                                </span>
                              )}
                            </div>
                          </m.div>
                        ))}
                      </AnimatePresence>
                    </div>
                  </m.div>
                );
              })}
            </AnimatePresence>
          )}
          {renderLoadMore('mobile')}
        </div>
      </div>

      <Drawer
        key={`dialog-${dialogKey}`}
        open={open}
        onClose={() => setOpen(false)}
        title="Add transaction"
      >
        <TransactionForm
          accounts={accounts}
          categories={categories}
          onDone={() => setOpen(false)}
        />
      </Drawer>

      <Drawer
        key={`drawer-${drawerKey}`}
        open={detailOpen}
        onClose={closeDetail}
        title="Transaction"
      >
        {detail && (
          <>
            <div className="font-display mt-4 text-[22px] font-semibold tracking-[-0.02em]">
              {detail.payee || detail.categoryName || 'Transaction'}
            </div>
            <div className="mt-4.5">
              <TransactionForm
                transaction={detail}
                accounts={accounts}
                categories={categories}
                onDone={() => {
                  closeDetail();
                  // an edit past page 1 may not change SSR page 1, so reload explicitly
                  setReloadNonce((n) => n + 1);
                }}
              />
            </div>
            {detail.importBatchFilename && detail.importBatchId && (
              <Link
                href={`/import/history/${detail.importBatchId}`}
                className="text-iris mt-3 block text-sm hover:underline"
              >
                Imported from {detail.importBatchFilename}
              </Link>
            )}
            <button
              type="button"
              onClick={() => setConfirmDeleteId(detail.id)}
              className="border-line text-rose mt-2 flex w-full items-center justify-center gap-1.5 rounded-full border py-3 text-[14px]"
            >
              <Trash2 size={15} />
              Delete
            </button>
          </>
        )}
      </Drawer>
      <ConfirmDialog
        open={confirmDeleteId !== null}
        title="Delete transaction"
        description="Delete this transaction? This can't be undone."
        pending={deletePending}
        onConfirm={() => confirmDeleteId && handleDelete(confirmDeleteId)}
        onCancel={() => setConfirmDeleteId(null)}
      />
      <TransactionFiltersDialog
        key={`filters-${filtersDialogKey}`}
        open={filtersDialogOpen}
        onClose={() => setFiltersDialogOpen(false)}
        filters={filters}
        onApply={pushFilters}
        accounts={accounts}
        categories={categories}
      />
      <MatchTransfersDialog
        key={`match-${matchDialogKey}`}
        open={matchDialogOpen}
        onClose={() => setMatchDialogOpen(false)}
        onConfirm={handleMatchTransfers}
        pending={matchPending}
      />

      <div
        className="border-line bg-paper-raised fixed inset-x-0 z-20 flex gap-2.5 border-t px-4.5 py-2.5 lg:hidden"
        style={{ bottom: 'calc(60px + env(safe-area-inset-bottom))' }}
      >
        <Link
          href="/import"
          className="border-line text-ink flex flex-1 items-center justify-center rounded-full border py-3 text-[14px] font-medium"
        >
          Import CSV
        </Link>
        <AddTransactionLink className="bg-iris text-paper-raised focus-visible:outline-paper-raised flex flex-[1.3] items-center justify-center gap-2 rounded-full py-3 text-[14.5px] font-semibold focus-visible:outline-2 focus-visible:outline-offset-2">
          <Plus size={16} /> Log a spend
        </AddTransactionLink>
      </div>
    </div>
  );
};
