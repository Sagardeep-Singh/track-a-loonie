import { test, expect, type Page } from '@playwright/test';

const EMAIL = process.env.ADMIN_EMAIL ?? 'dev@example.com';
const PASSWORD = process.env.ADMIN_PASSWORD ?? 'devpassword123';

const login = async (page: Page): Promise<void> => {
  await page.goto('/login');
  await page.getByLabel('Email').fill(EMAIL);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard/);
};

const addTransaction = async (
  page: Page,
  { payee, amount, type }: { payee: string; amount: string; type: 'EXPENSE' | 'INCOME' },
): Promise<void> => {
  await page.getByRole('button', { name: 'Add transaction' }).click();
  const drawer = page.getByRole('dialog', { name: 'Add transaction' });
  await expect(drawer).toBeVisible();
  if (type === 'INCOME') {
    // The type toggle ("Spend"/"Income") sits above the amount field; a
    // category chip can also be named "Income", so scope to the first match.
    await drawer.getByRole('button', { name: 'Income' }).first().click();
  }
  await drawer.getByLabel('Payee').fill(payee);
  await drawer.locator('#amount').fill(amount);
  await drawer.getByRole('button', { name: 'Save transaction' }).click();
  await expect(drawer).toBeHidden();
};

test('payee search filters immediately and the filters dialog applies type + amount range, syncing to the URL', async ({
  page,
}) => {
  await login(page);
  await page.goto('/transactions');

  const stamp = Date.now();
  const coffeePayee = `E2E Filter Coffee ${stamp}`;
  const paycheckPayee = `E2E Filter Paycheck ${stamp}`;

  await addTransaction(page, { payee: coffeePayee, amount: '4.50', type: 'EXPENSE' });
  await addTransaction(page, { payee: paycheckPayee, amount: '900.00', type: 'INCOME' });

  const coffeeRow = page.locator('.ledger-row').filter({ hasText: coffeePayee });
  const paycheckRow = page.locator('.ledger-row').filter({ hasText: paycheckPayee });
  await expect(coffeeRow).toBeVisible();
  await expect(paycheckRow).toBeVisible();

  // The payee search box needs no "Apply" step: once typing pauses (300ms
  // debounce) the list is re-queried server-side. Wait for that request
  // rather than asserting synchronously after the keystroke.
  const searchSettled = (): Promise<unknown> =>
    page.waitForResponse(
      (r) => r.url().includes('/api/transactions?') && r.url().includes('paginated=1'),
    );
  let settled = searchSettled();
  await page.getByPlaceholder('Search payee', { exact: true }).fill(`Coffee ${stamp}`);
  await settled;
  await expect(coffeeRow).toBeVisible();
  await expect(paycheckRow).toBeHidden();
  settled = searchSettled();
  await page.getByPlaceholder('Search payee', { exact: true }).fill('');
  await settled;
  await expect(paycheckRow).toBeVisible();

  // The default current-month range lives in the period selector, not the
  // dialog, so the badge starts empty.
  const filtersButton = page.getByRole('button', { name: /^Filters/ });
  await expect(filtersButton.locator('span')).toHaveCount(0);

  await filtersButton.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();

  await dialog.getByRole('button', { name: 'Income', exact: true }).click();
  await dialog.getByPlaceholder('Min').fill('100');
  await dialog.getByRole('button', { name: 'Apply' }).click();
  await expect(dialog).toBeHidden();

  // Two active filter groups (type + amount range) -> badge reads "2".
  await expect(filtersButton.locator('span')).toHaveText('2');
  await expect(paycheckRow).toBeVisible();
  await expect(coffeeRow).toBeHidden();

  // Filter state is in the URL and survives a reload.
  await expect(page).toHaveURL(/type=INCOME/);
  await expect(page).toHaveURL(/amountMin=100/);
  await page.reload();
  await expect(page.getByRole('button', { name: /^Filters/ }).locator('span')).toHaveText('2');
  await expect(page.locator('.ledger-row').filter({ hasText: paycheckPayee })).toBeVisible();
  await expect(page.locator('.ledger-row').filter({ hasText: coffeePayee })).toBeHidden();

  // "Reset" inside the dialog clears every group and the badge disappears. The
  // period selector's month stays put.
  await page.getByRole('button', { name: /^Filters/ }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button', { name: 'Reset' }).click();
  await page.getByRole('button', { name: 'Apply' }).click();
  await expect(page.getByRole('button', { name: /^Filters/ }).locator('span')).toHaveCount(0);
  await expect(page.locator('.ledger-row').filter({ hasText: coffeePayee })).toBeVisible();
  await expect(page.locator('.ledger-row').filter({ hasText: paycheckPayee })).toBeVisible();
});

test('the period selector, quick filters and dialog share one URL state', async ({ page }) => {
  await login(page);
  await page.goto('/transactions');
  await expect(page).toHaveURL(/from=\d{4}-\d{2}-01&to=/);

  const now = new Date();
  const monthName = now.toLocaleString('en-US', { month: 'long', timeZone: 'UTC' });
  const period = page.getByRole('button', { name: `${monthName} ${now.getUTCFullYear()}` });
  await expect(period).toBeVisible();

  // Custom range from the selector writes from/to and relabels the pill.
  await period.click();
  // The picker body also sits in the (hidden) mobile sheet, so scope to the visible one.
  await page
    .getByLabel('From', { exact: true })
    .filter({ visible: true })
    .fill(`${now.getUTCFullYear()}-01-03`);
  await page
    .getByLabel('To', { exact: true })
    .filter({ visible: true })
    .fill(`${now.getUTCFullYear()}-01-20`);
  await page.getByRole('button', { name: 'Apply range' }).click();
  await expect(page).toHaveURL(new RegExp(`from=${now.getUTCFullYear()}-01-03`));
  await expect(page.getByRole('button', { name: /^Jan 3 – Jan 20, \d{4}$/ })).toBeVisible();

  // "Spending" in the dialog is the same filter the mobile pill writes.
  await page.getByRole('button', { name: /^Filters/ }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Spending', exact: true }).click();
  await page.getByRole('button', { name: 'Apply' }).click();
  await expect(page).toHaveURL(/type=EXPENSE/);
  // Applying dialog filters keeps the custom range.
  await expect(page).toHaveURL(new RegExp(`from=${now.getUTCFullYear()}-01-03`));
});

test('the account and category pickers search, toggle, show chips, and keep Escape inside the panel', async ({
  page,
}) => {
  await login(page);
  await page.goto('/transactions');

  await page.getByRole('button', { name: /^Filters/ }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();

  const categoriesTrigger = dialog.locator('#filter-categories');
  const accountsTrigger = dialog.locator('#filter-accounts');
  const categorySearch = dialog.getByRole('combobox', { name: 'Search categories' });
  const accountSearch = dialog.getByRole('combobox', { name: 'Search accounts' });

  // No long checkbox list until a picker is opened.
  await expect(dialog.getByRole('option')).toHaveCount(0);
  await expect(categoriesTrigger).toHaveText('All categories');

  // Only one picker is open at a time.
  await accountsTrigger.click();
  await expect(accountSearch).toBeFocused();
  await categoriesTrigger.click();
  await expect(accountSearch).toBeHidden();
  await expect(categorySearch).toBeFocused();

  // Typing narrows the list; Enter toggles the highlighted option.
  await categorySearch.fill('groc');
  await expect(dialog.getByRole('option')).toHaveCount(1);
  await categorySearch.press('Enter');
  await expect(dialog.getByRole('option', { name: 'Groceries' })).toHaveAttribute(
    'aria-selected',
    'true',
  );

  await categorySearch.fill('zzz-no-such-category');
  await expect(dialog.getByText('No matches')).toBeVisible();

  // Escape closes the panel only, not the whole dialog.
  await categorySearch.press('Escape');
  await expect(categorySearch).toBeHidden();
  await expect(dialog).toBeVisible();
  await expect(categoriesTrigger).toHaveText('Groceries');
  await expect(categoriesTrigger).toBeFocused();

  // Reopening lists the selection first; a second pick switches to chips.
  await categoriesTrigger.click();
  await expect(dialog.getByRole('option').first()).toHaveText('Groceries');
  await dialog.getByRole('option', { name: 'Rent' }).click();
  await dialog.getByRole('button', { name: 'Done' }).click();
  await expect(categoriesTrigger).toHaveText('2 selected');
  await expect(dialog.getByRole('button', { name: 'Remove Rent' })).toBeVisible();

  await dialog.getByRole('button', { name: 'Apply' }).click();
  await expect(dialog).toBeHidden();
  await expect(page).toHaveURL(/categoryIds=[^&]+%2C/);
  await expect(page.getByRole('button', { name: /^Filters/ }).locator('span')).toHaveText('1');

  // Removing a chip edits the draft; Apply writes it back to the URL.
  await page.getByRole('button', { name: /^Filters/ }).click();
  await dialog.getByRole('button', { name: 'Remove Rent' }).click();
  await expect(categoriesTrigger).toHaveText('Groceries');
  await dialog.getByRole('button', { name: 'Apply' }).click();
  await expect(page).toHaveURL(/categoryIds=[^&%]+(&|$)/);

  // Clear empties the picker.
  await page.getByRole('button', { name: /^Filters/ }).click();
  await categoriesTrigger.click();
  await dialog.getByRole('button', { name: 'Clear' }).click();
  await expect(categoriesTrigger).toHaveText('All categories');
  await dialog.getByRole('button', { name: 'Apply' }).click();
  await expect(page).not.toHaveURL(/categoryIds=/);
});
