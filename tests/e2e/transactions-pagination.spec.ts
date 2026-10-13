import { test, expect, type Browser, type Locator, type Page } from '@playwright/test';
import { getCalendarMonthPeriod, getStatementPeriod } from '../../lib/statement';

/**
 * Server-side pagination of the Transactions page
 * (docs/feature-plans/transactions-server-side-pagination.md, Test Plan §3).
 *
 * Every case runs against data this spec alone owns: dedicated accounts
 * stamped with Date.now(), seeded through the authenticated API (the browser
 * context carries the session cookie), and every visit is scoped with
 * `?accountIds=` so the shared dev DB's other rows can't skew a count.
 *
 * Serial with ONE login in beforeAll: login is rate-limited per email
 * (10 per 15 minutes), so a login per test would lock the dev user out.
 */

test.describe.configure({ mode: 'serial' });

const EMAIL = process.env.ADMIN_EMAIL ?? 'dev@example.com';
const PASSWORD = process.env.ADMIN_PASSWORD ?? 'devpassword123';
const DAY_MS = 24 * 60 * 60 * 1000;

const stamp = Date.now();
const names = {
  bulk: `E2E Pagination Bulk ${stamp}`,
  mixed: `E2E Pagination Mixed ${stamp}`,
  chips: `E2E Pagination Chips ${stamp}`,
  category: `E2E Pag Cat ${stamp}`,
};
const BULK_ROWS = 105; // page 1 = 50, page 2 = 50, page 3 = 5
const BULK_DAY = '2026-02-10';

const isoDay = (date: Date): string => date.toISOString().slice(0, 10);
const now = new Date();
const statement = getStatementPeriod(15, now);
const month = getCalendarMonthPeriod(now.getUTCFullYear() * 100 + now.getUTCMonth() + 1);
const days = {
  statementCurrent: isoDay(statement.start),
  statementPrevious: isoDay(new Date(statement.start.getTime() - DAY_MS)),
  monthCurrent: isoDay(month.start),
  monthPrevious: isoDay(new Date(month.start.getTime() - DAY_MS)),
};

let page: Page;
const ids = { bulk: '', mixed: '', chips: '', category: '' };
const linkIds: string[] = [];

const login = async (p: Page): Promise<void> => {
  await p.goto('/login');
  await p.getByLabel('Email').fill(EMAIL);
  await p.getByLabel('Password').fill(PASSWORD);
  await p.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(p).toHaveURL(/\/dashboard/);
};

const post = async <T>(url: string, data: Record<string, unknown>): Promise<T> => {
  const res = await page.request.post(url, { data });
  expect(res.status(), `${url} ${JSON.stringify(data)}`).toBeLessThan(300);
  return (await res.json()) as T;
};

const createTx = (data: Record<string, unknown>): Promise<{ id: string }> =>
  post<{ id: string }>('/api/transactions', { type: 'EXPENSE', ...data });

const isPaginatedResponse = (url: string): boolean =>
  url.includes('/api/transactions?') && url.includes('paginated=1');

const rows = (): Locator => page.locator('.ledger-row');
const row = (payee: string): Locator => rows().filter({ hasText: payee });
const loadMore = (): Locator =>
  page.getByTestId('transactions-list-desktop').getByRole('button', { name: 'Load more' });

const visit = async (accountIds: string[], range?: { from: string; to: string }): Promise<void> => {
  const period = range ? `&from=${range.from}&to=${range.to}` : '';
  await page.goto(`/transactions?accountIds=${accountIds.join(',')}${period}`);
  await expect(page.getByTestId('transactions-list-desktop')).toBeVisible();
};

/** The desktop totals card (the mobile one renders too, CSS-hidden). */
const summary = (): Locator => page.getByTestId('transactions-summary');

/** Picks a custom range in the header's period selector (a shallow URL update). */
const pickRange = async (from: string, to: string): Promise<void> => {
  // the trigger is labelled with the current selection: "All time", a month or a range
  await page
    .getByRole('button', { name: /^(All time|.*\d{4})$/ })
    .filter({ visible: true })
    .first()
    .click();
  await page.getByLabel('From', { exact: true }).filter({ visible: true }).fill(from);
  await page.getByLabel('To', { exact: true }).filter({ visible: true }).fill(to);
  const response = page.waitForResponse((r) => isPaginatedResponse(r.url()));
  await page.getByRole('button', { name: 'Apply range' }).click();
  await response;
};

/** Opens the Filters dialog, lets `edit` change it, applies, and waits for the refetch. */
/** Opens an account/category picker in the Filters dialog and toggles one option. */
const togglePickerOption = async (
  dialog: Locator,
  trigger: string,
  name: string,
): Promise<void> => {
  await dialog.locator(trigger).click();
  await dialog.getByRole('option', { name, exact: true }).click();
};

const applyFilters = async (edit: (dialog: Locator) => Promise<void>): Promise<void> => {
  await page.getByRole('button', { name: /^Filters/ }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await edit(dialog);
  const response = page.waitForResponse((r) => isPaginatedResponse(r.url()));
  await dialog.getByRole('button', { name: 'Apply' }).click();
  await expect(dialog).toBeHidden();
  await response;
};

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  test.setTimeout(180_000);
  page = await browser.newPage();
  await login(page);

  ids.bulk = (
    await post<{ id: string }>('/api/accounts', { name: names.bulk, type: 'CHECKING' })
  ).id;
  ids.mixed = (
    await post<{ id: string }>('/api/accounts', {
      name: names.mixed,
      type: 'CREDIT_CARD',
      statementDay: 15,
    })
  ).id;
  ids.chips = (
    await post<{ id: string }>('/api/accounts', { name: names.chips, type: 'CHECKING' })
  ).id;
  ids.category = (await post<{ id: string }>('/api/categories', { name: names.category })).id;

  // 105 identical $10 expenses on ONE day: page boundaries fall inside a single
  // day group, and every running balance is hand-computable.
  for (let start = 0; start < BULK_ROWS; start += 15) {
    await Promise.all(
      Array.from({ length: Math.min(15, BULK_ROWS - start) }, (_, k) =>
        createTx({
          accountId: ids.bulk,
          amount: 10,
          date: BULK_DAY,
          payee: `Bulk ${stamp} #${start + k + 1}`,
        }),
      ),
    );
  }

  // Filter / period fixtures on the credit card (statement day 15).
  await createTx({
    accountId: ids.mixed,
    amount: 4.5,
    date: days.statementCurrent,
    payee: `Mixed Coffee ${stamp}`,
    categoryId: ids.category,
  });
  await createTx({
    accountId: ids.mixed,
    amount: 60,
    date: days.statementPrevious,
    payee: `Mixed Groceries ${stamp}`,
  });
  await createTx({
    accountId: ids.mixed,
    amount: 25,
    date: days.monthCurrent,
    payee: `Mixed Month Now ${stamp}`,
    categoryId: ids.category,
  });
  await createTx({
    accountId: ids.mixed,
    amount: 35,
    date: days.monthPrevious,
    payee: `Mixed Month Before ${stamp}`,
    categoryId: ids.category,
  });
  await createTx({
    accountId: ids.mixed,
    type: 'INCOME',
    amount: 300,
    date: days.monthPrevious,
    payee: `Mixed Card Payment ${stamp}`,
    isPayment: true,
    categoryId: ids.category,
  });
  await createTx({
    accountId: ids.mixed,
    amount: 80,
    date: days.monthPrevious,
    payee: `Mixed Transfer ${stamp}`,
    isTransfer: true,
    categoryId: ids.category,
  });

  // Summary-bar bucket fixtures.
  const chip = (data: Record<string, unknown>): Promise<{ id: string }> =>
    createTx({ accountId: ids.chips, date: '2026-01-20', ...data });
  await chip({ type: 'INCOME', amount: 100, payee: `Chips Salary ${stamp}` });
  await chip({ type: 'INCOME', amount: 200, payee: `Chips Payment ${stamp}`, isPayment: true });
  await chip({
    type: 'INCOME',
    amount: 30,
    payee: `Chips Payment+Transfer ${stamp}`,
    isPayment: true,
    isTransfer: true,
  });
  await chip({ amount: 50, payee: `Chips Transfer ${stamp}`, isTransfer: true });
  const expense = await chip({
    amount: 40,
    payee: `Chips Work Lunch ${stamp}`,
    isReimbursable: true,
    reimbursementExpectedAmount: 40,
  });
  const payback = await chip({ type: 'INCOME', amount: 40, payee: `Chips Payback ${stamp}` });
  const linked = await post<{ links: { id: string }[] }>('/api/reimbursement-links', {
    expenseTransactionId: expense.id,
    incomeTransactionId: payback.id,
    amount: 40,
  });
  linkIds.push(...linked.links.map((l) => l.id));
});

// Leave the shared dev user as we found it: the link blocks account deletion,
// so it goes first; deleting an account cascades its transactions.
test.afterAll(async () => {
  if (!page) return;
  for (const id of linkIds) await page.request.delete(`/api/reimbursement-links/${id}`);
  for (const id of [ids.bulk, ids.mixed, ids.chips]) {
    if (id) await page.request.delete(`/api/accounts/${id}`);
  }
  if (ids.category) await page.request.delete(`/api/categories/${ids.category}`);
  await page.close();
});

test('1. initial load is bounded to one page (SSR, no client fetch)', async () => {
  await visit([ids.bulk]);
  await expect(rows()).toHaveCount(50);
  await expect(summary().getByText('105 transactions', { exact: true })).toBeVisible();
});

test('9 (first half). the day header shows the FULL day total before every row is loaded', async () => {
  const headers = page.getByTestId('transaction-day-desktop');
  await expect(headers).toHaveCount(1);
  await expect(headers.getByTestId('transaction-day-total')).toHaveText('−1050.00');
});

test('3. Load more shows a disabled loading state without changing its label', async () => {
  await page.route(/\/api\/transactions\?.*cursor=/, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    await route.continue();
  });
  const response = page.waitForResponse((r) => isPaginatedResponse(r.url()));
  await loadMore().click();
  const button = page.getByTestId('transactions-list-desktop').getByRole('button', {
    name: 'Load more',
  });
  await expect(button).toBeDisabled();
  await response;
  await page.unrouteAll({ behavior: 'wait' });
});

test('2 + 13a. Load more appends a page and keeps focus on the button while more remain', async () => {
  await expect(rows()).toHaveCount(100);
  await expect(loadMore()).toBeEnabled();
  await expect(loadMore()).toBeFocused();
  await expect(page.getByTestId('transactions-load-status-desktop')).toHaveText(
    'Loaded 50 more transactions. 100 of 105 shown.',
  );
});

test('7. running balance stays continuous across the page boundary', async () => {
  const balances = page.getByTestId('running-balance');
  // newest first: the newest row carries the whole scope's total, the
  // oldest just its own -10; each older row is exactly 10 higher.
  await expect(balances.nth(0)).toHaveText('-1050.00');
  await expect(balances.nth(49)).toHaveText('-560.00'); // last row of page 1
  await expect(balances.nth(50)).toHaveText('-550.00'); // first row of page 2
  await expect(balances.nth(99)).toHaveText('-60.00');
});

test('10. a failed Load more is retryable and never drops loaded rows', async () => {
  await page.route(/\/api\/transactions\?.*cursor=/, (route) =>
    route.fulfill({ status: 500, body: '{"error":"boom"}' }),
  );
  await loadMore().click();
  const list = page.getByTestId('transactions-list-desktop');
  await expect(list.getByRole('button', { name: 'Try again' })).toBeVisible();
  await expect(list.getByRole('alert')).toHaveText("Couldn't load more transactions. Try again.");
  await expect(rows()).toHaveCount(100);
  await page.unrouteAll({ behavior: 'wait' });

  const response = page.waitForResponse((r) => isPaginatedResponse(r.url()));
  await list.getByRole('button', { name: 'Try again' }).click();
  await response;
  await expect(rows()).toHaveCount(105);
});

test('2 + 13b. the last page removes the button and moves focus to the status line', async () => {
  await expect(page.getByTestId('transactions-list-desktop').getByRole('button')).toHaveCount(0);
  const status = page.getByTestId('transactions-load-status-desktop');
  await expect(status).toBeFocused();
  await expect(status).toHaveText('Loaded 5 more transactions. 105 of 105 shown.');
  expect(await page.evaluate(() => document.activeElement?.getAttribute('tabindex'))).toBe('-1');
});

test('9 (second half). the day total is unchanged and there is still one header', async () => {
  const headers = page.getByTestId('transaction-day-desktop');
  await expect(headers).toHaveCount(1);
  await expect(headers.getByTestId('transaction-day-total')).toHaveText('−1050.00');
  await expect(rows().filter({ hasText: `Bulk ${stamp} #` })).toHaveCount(105);
});

test('12. a filter change resets the loaded pages to a fresh page 1', async () => {
  await applyFilters((dialog) => dialog.getByLabel('Hide transfers').check());
  await expect(page).toHaveURL(/hideTransfers=true/);
  await expect(rows()).toHaveCount(50);
  await expect(loadMore()).toBeVisible();
});

test('11. the payee search is debounced: no request until typing pauses, then exactly one', async () => {
  await visit([ids.bulk]);
  let requestCount = 0;
  await page.route(/\/api\/transactions\?.*paginated=1/, async (route) => {
    requestCount++;
    await new Promise((resolve) => setTimeout(resolve, 400));
    await route.continue();
  });

  const search = page.getByPlaceholder('Search payee', { exact: true });
  const response = page.waitForResponse((r) => isPaginatedResponse(r.url()));
  await search.fill(`#105`);
  await page.waitForTimeout(250);
  expect(requestCount).toBe(0);

  // in flight: the pill swaps to its pending state and the list is busy/dimmed
  await expect(page.getByTestId('transactions-search-desktop')).toHaveAttribute(
    'data-pending',
    'true',
  );
  await expect(page.getByTestId('transactions-list-desktop')).toHaveAttribute('aria-busy', 'true');
  await response;

  await expect(rows()).toHaveCount(1);
  await expect(row(`Bulk ${stamp} #105`)).toBeVisible();
  await expect(page.getByTestId('transactions-search-desktop')).toHaveAttribute(
    'data-pending',
    'false',
  );
  await expect(page).toHaveURL(/payee=%23105/);
  expect(requestCount).toBe(1);
  await page.unrouteAll({ behavior: 'wait' });
});

test('11b. a slow URL push neither snaps the search back nor survives a later clear', async () => {
  await visit([ids.bulk]);
  // hold every RSC navigation (the debounced URL push) in flight for a while
  await page.route(/\/transactions\?/, async (route) => {
    if (route.request().headers()['rsc'] === '1') {
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
    // the router aborts a superseded navigation while we hold it; that's fine
    await route.continue().catch(() => undefined);
  });
  const search = page.getByPlaceholder('Search payee', { exact: true });
  const settled = (): Promise<unknown> => page.waitForResponse((r) => isPaginatedResponse(r.url()));

  let response = settled();
  await search.fill('#10');
  await response; // settled + pushed; its URL echo is still in flight
  response = settled();
  await search.fill('#105');
  await response;
  await expect(search).toHaveValue('#105'); // the '#10' echo must not snap it back
  await expect(rows()).toHaveCount(1);

  response = settled();
  await search.fill('');
  await response;
  await expect(rows()).toHaveCount(50);
  await expect(page).not.toHaveURL(/payee=/, { timeout: 10_000 });
  await expect(search).toHaveValue('');
  // held navigations may have been aborted by the router: don't wait on them
  await page.unrouteAll({ behavior: 'ignoreErrors' });

  await page.reload();
  await expect(rows()).toHaveCount(50);
  await expect(page.getByPlaceholder('Search payee', { exact: true })).toHaveValue('');
});

test('4. every filter type narrows server-side, then widens again', async () => {
  const coffee = row(`Mixed Coffee ${stamp}`);
  const groceries = row(`Mixed Groceries ${stamp}`); // uncategorized
  const payment = row(`Mixed Card Payment ${stamp}`);
  const transfer = row(`Mixed Transfer ${stamp}`);
  const salary = row(`Chips Salary ${stamp}`);

  await visit([ids.mixed]);
  await expect(coffee).toBeVisible();
  await expect(salary).toBeHidden();

  // accountIds: widen to a second account, then narrow back
  await applyFilters((d) => togglePickerOption(d, '#filter-accounts', names.chips));
  await expect(salary).toBeVisible();
  await expect(coffee).toBeVisible();
  await applyFilters((d) => togglePickerOption(d, '#filter-accounts', names.chips));
  await expect(salary).toBeHidden();

  // categoryIds
  await applyFilters((d) => togglePickerOption(d, '#filter-categories', names.category));
  await expect(coffee).toBeVisible();
  await expect(groceries).toBeHidden();
  await applyFilters((d) => togglePickerOption(d, '#filter-categories', names.category));
  await expect(groceries).toBeVisible();

  // from / to (inclusive single day) — the period selector's params, now outside the dialog
  await visit([ids.mixed], { from: days.statementCurrent, to: days.statementCurrent });
  await expect(coffee).toBeVisible();
  await expect(groceries).toBeHidden();
  await visit([ids.mixed]);
  await expect(groceries).toBeVisible();

  // hideTransfers
  await applyFilters((d) => d.getByLabel('Hide transfers').check());
  await expect(transfer).toBeHidden();
  await expect(payment).toBeVisible();
  await applyFilters((d) => d.getByLabel('Hide transfers').uncheck());
  await expect(transfer).toBeVisible();

  // hidePayments
  await applyFilters((d) => d.getByLabel('Hide card payments').check());
  await expect(payment).toBeHidden();
  await expect(transfer).toBeVisible();
  await applyFilters((d) => d.getByLabel('Hide card payments').uncheck());
  await expect(payment).toBeVisible();

  // uncategorizedOnly
  await applyFilters((d) => d.getByLabel('Uncategorized only').check());
  await expect(groceries).toBeVisible();
  await expect(coffee).toBeHidden();
  await applyFilters((d) => d.getByLabel('Uncategorized only').uncheck());
  await expect(coffee).toBeVisible();
});

test('5. the period selector narrows to a month server-side; another month swaps it', async () => {
  await visit([ids.mixed]);
  const current = row(`Mixed Month Now ${stamp}`);
  const previous = row(`Mixed Month Before ${stamp}`);
  await expect(current).toBeVisible();
  await expect(previous).toBeVisible();

  const monthEnd = isoDay(new Date(month.end.getTime() - DAY_MS));
  await pickRange(days.monthCurrent, monthEnd);
  await expect(page).toHaveURL(new RegExp(`from=${days.monthCurrent}&to=${monthEnd}`));
  await expect(current).toBeVisible();
  await expect(previous).toBeHidden();

  await pickRange(days.monthPrevious, days.monthPrevious);
  await expect(previous).toBeVisible();
  await expect(current).toBeHidden();
});

test('6. By statement places rows on each side of the close date correctly', async () => {
  await visit([ids.mixed]);
  const inCurrent = row(`Mixed Coffee ${stamp}`); // first day of the current statement
  const inPrevious = row(`Mixed Groceries ${stamp}`); // the previous statement's close day

  let response = page.waitForResponse((r) => isPaginatedResponse(r.url()));
  await page.getByRole('button', { name: 'View by statement' }).click();
  await response;
  await expect(inCurrent).toBeVisible();
  await expect(inPrevious).toBeHidden();

  response = page.waitForResponse((r) => isPaginatedResponse(r.url()));
  await page.getByRole('button', { name: 'Previous statement' }).click();
  await response;
  await expect(inPrevious).toBeVisible();
  await expect(inCurrent).toBeHidden();
});

test('8. totals card keeps bucket precedence and nets reimbursed spending', async () => {
  await visit([ids.chips]);
  const bar = summary();
  await expect(bar).toContainText('6 transactions');
  const stat = (label: string): Locator =>
    bar.locator('dt', { hasText: label }).locator('xpath=following-sibling::dd[1]');
  // the $40 payback is linked reimbursement income, so it is NOT credit
  await expect(stat('Credit')).toContainText('100.00');
  // the $40 lunch is fully reimbursed, so it nets out of Debit (like Overview's Out)
  await expect(stat('Debit')).toContainText('0.00');
  await expect(stat('Net')).toContainText('100.00');
  const excluded = (label: string): Locator =>
    bar.locator('span').filter({ hasText: label }).locator('span.font-money');
  // payment AND transfer (30) counts toward payments only
  await expect(excluded('Payments')).toHaveText('$230.00');
  await expect(excluded('Transfers')).toHaveText('$50.00');
  await expect(excluded('Reimbursements')).toHaveText('$40.00');
});

test('8b. the pending reimbursements filter narrows server-side', async () => {
  await visit([ids.chips]);
  const lunch = row(`Chips Work Lunch ${stamp}`);
  await expect(lunch).toBeVisible();
  // fully linked, so not pending
  await page.goto(`/transactions?accountIds=${ids.chips}&pendingReimbursementsOnly=true`);
  await expect(page.getByTestId('transactions-list-desktop')).toBeVisible();
  await expect(rows()).toHaveCount(0);
  await expect(summary()).toContainText('0 transactions');
});

test('14. a transaction added from the page appears without a manual reload', async () => {
  await visit([ids.chips]);
  const payee = `Chips Added Live ${stamp}`;
  await page.getByRole('button', { name: 'Add transaction' }).click();
  const drawer = page.getByRole('dialog', { name: 'Add transaction' });
  await expect(drawer).toBeVisible();
  await drawer.locator('#accountId').selectOption({ label: names.chips });
  await drawer.getByLabel('Payee').fill(payee);
  await drawer.locator('#amount').fill('7.25');
  const response = page.waitForResponse((r) => isPaginatedResponse(r.url()));
  await drawer.getByRole('button', { name: 'Save transaction' }).click();
  await expect(drawer).toBeHidden();
  await response;
  await expect(row(payee)).toBeVisible();
  await expect(summary().getByText('7 transactions', { exact: true })).toBeVisible();
});

type PageEnvelope = {
  rows: { id: string }[];
  nextCursor: string | null;
  hasMore: boolean;
  totalCount: number;
  desktopCount: number;
};

const getPage = async (query: string): Promise<PageEnvelope> => {
  const res = await page.request.get(`/api/transactions?paginated=1&limit=50&${query}`);
  expect(res.status(), query).toBe(200);
  return (await res.json()) as PageEnvelope;
};

test('Mode B against the real DB: amount search pages through the whole scope', async () => {
  const scope = `accountIds=${ids.bulk}&mobileSearch=10.00`;
  const first = await getPage(scope);
  expect(first).toMatchObject({ totalCount: 105, desktopCount: 105, hasMore: true });
  expect(first.rows).toHaveLength(50);

  const second = await getPage(`${scope}&cursor=${first.nextCursor}`);
  expect(second.rows).toHaveLength(50);
  const third = await getPage(`${scope}&cursor=${second.nextCursor}`);
  expect(third.rows).toHaveLength(5);
  expect(third).toMatchObject({ hasMore: false, nextCursor: null });

  const all = [...first.rows, ...second.rows, ...third.rows].map((r) => r.id);
  expect(new Set(all).size).toBe(105); // no row skipped or duplicated across pages
});

test('a literal % in the payee never wildcard-matches (probe consequence, live)', async () => {
  const percent = await getPage(`accountIds=${ids.bulk}&payee=${encodeURIComponent('%')}`);
  expect(percent.totalCount).toBe(0);
  const underscore = await getPage(`accountIds=${ids.bulk}&payee=${encodeURIComponent('_')}`);
  expect(underscore.totalCount).toBe(0);
  // sanity: a real substring still matches
  const hash = await getPage(`accountIds=${ids.bulk}&payee=${encodeURIComponent('#10')}`);
  expect(hash.totalCount).toBe(7); // #10 and #100-#105
});

test('a malformed cursor is a 400, not a silent restart', async () => {
  const res = await page.request.get(
    `/api/transactions?paginated=1&accountIds=${ids.bulk}&cursor=not-a-cursor!!`,
  );
  expect(res.status()).toBe(400);
});

test('10 (AC 10). opening and closing the add overlay keeps the loaded pages', async () => {
  // Closing the overlay pushes a bare /transactions, which `proxy.ts` redirects
  // to the stored period: store the bulk rows' month so it lands on the same scope.
  const month = BULK_DAY.slice(0, 7);
  await page
    .context()
    .addCookies([
      { name: 'period', value: `m:${month.replace('-', '')}`, url: 'http://localhost:3000' },
    ]);
  await page.goto('/transactions');
  const scopedUrl = new RegExp(`/transactions\\?from=${month}-01&to=${month}-\\d{2}$`);
  await expect(page).toHaveURL(scopedUrl);
  await expect(rows()).toHaveCount(50);
  const response = page.waitForResponse((r) => isPaginatedResponse(r.url()));
  await loadMore().click();
  await response;
  await expect(rows()).toHaveCount(100);

  await page.getByRole('link', { name: 'Log a transaction' }).click();
  const overlay = page.getByRole('dialog', { name: 'Log a transaction' });
  await expect(overlay).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(overlay).toBeHidden();
  await expect(page).toHaveURL(scopedUrl);
  // give any (wrong) refetch time to land before asserting nothing collapsed
  await page.waitForTimeout(1500);
  await expect(rows()).toHaveCount(100);
  await page.context().clearCookies({ name: 'period' });
});

test('mobile: amount search, count line and Load more drive the mobile tree', async ({
  browser,
}) => {
  const context = await browser.newContext({
    viewport: { width: 402, height: 874 },
    storageState: await page.context().storageState(),
  });
  const mobile = await context.newPage();
  await mobile.goto(`/transactions?accountIds=${ids.bulk}`);
  const mobileRows = mobile.getByTestId('transaction-row-mobile');
  await expect(mobileRows).toHaveCount(50);

  let response = mobile.waitForResponse((r) => isPaginatedResponse(r.url()));
  await mobile.getByPlaceholder('Search payee or amount').fill('10.00');
  await response;
  await expect(
    mobile
      .getByTestId('transaction-totals')
      .filter({ visible: true })
      .getByText('105 transactions'),
  ).toBeVisible();
  await expect(mobileRows).toHaveCount(50);

  response = mobile.waitForResponse((r) => isPaginatedResponse(r.url()));
  await mobile
    .getByTestId('transactions-list-mobile')
    .getByRole('button', { name: 'Load more' })
    .click();
  await response;
  await expect(mobileRows).toHaveCount(100);
  await expect(mobile.getByTestId('transactions-load-status-mobile')).toHaveText(
    'Loaded 50 more transactions. 100 of 105 shown.',
  );

  // a quick-filter pill is a scope change: back to a fresh page 1 (all are spending)
  response = mobile.waitForResponse((r) => isPaginatedResponse(r.url()));
  await mobile.getByRole('button', { name: 'Spending' }).click();
  await response;
  await expect(mobileRows).toHaveCount(50);
  await context.close();
});
