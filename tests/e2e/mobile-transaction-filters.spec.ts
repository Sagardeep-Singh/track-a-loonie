import { test, expect, type Page } from '@playwright/test';

test.use({ viewport: { width: 402, height: 874 } });

const EMAIL = process.env.ADMIN_EMAIL ?? 'dev@example.com';
const PASSWORD = process.env.ADMIN_PASSWORD ?? 'devpassword123';

const login = async (page: Page): Promise<void> => {
  await page.goto('/login');
  await page.getByLabel('Email').fill(EMAIL);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard/);
};

const cta = (page: Page) => page.getByRole('link', { name: /Log a spend/ });
const shell = (page: Page) => page.getByTestId('log-a-spend-mobile');

/** Types an amount by tapping keypad keys, the only amount input this screen has. */
const tapAmount = async (page: Page, amount: string): Promise<void> => {
  for (const char of amount) {
    await shell(page)
      .getByRole('button', { name: char === '.' ? 'Decimal point' : char, exact: true })
      .click();
  }
};

const addTransaction = async (
  page: Page,
  { payee, amount }: { payee: string; amount: string },
): Promise<void> => {
  await cta(page).click();
  await expect(shell(page)).toBeVisible();
  await shell(page).getByLabel('Payee').fill(payee);
  await tapAmount(page, amount);
  await shell(page).getByRole('button', { name: 'Save transaction' }).click();
  await expect(shell(page)).toHaveCount(0);
};

test('the mobile Filters button opens the same filter dialog as desktop and narrows the list via the URL', async ({
  page,
}) => {
  await login(page);
  await page.goto('/transactions');

  const stamp = Date.now();
  const cafePayee = `E2E Mobile Filter Cafe ${stamp}`;
  const rentPayee = `E2E Mobile Filter Rent ${stamp}`;

  await addTransaction(page, { payee: cafePayee, amount: '5.25' });
  await addTransaction(page, { payee: rentPayee, amount: '1500.00' });

  const cafeRow = page.getByTestId('transaction-row-mobile').filter({ hasText: cafePayee });
  const rentRow = page.getByTestId('transaction-row-mobile').filter({ hasText: rentPayee });
  await expect(cafeRow).toBeVisible();
  await expect(rentRow).toBeVisible();

  const filtersButton = page.getByTestId('mobile-filters-button');
  await expect(filtersButton.locator('span')).toHaveCount(0);

  await filtersButton.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await dialog.locator('#filter-amount-max').fill('100');
  await dialog.getByRole('button', { name: 'Apply' }).click();
  await expect(dialog).toBeHidden();

  await expect(page).toHaveURL(/amountMax=100/);
  await expect(cafeRow).toBeVisible();
  await expect(rentRow).toBeHidden();

  // The badge reflects the one active group (amount range) from the same
  // dialog state the desktop button reads.
  await expect(filtersButton.locator('span')).toHaveText('1');
});

test('the Spending / Income pills write the same type filter the dialog shows', async ({
  page,
}) => {
  await login(page);
  await page.goto('/transactions');

  const pills = page.getByTestId('transaction-filters');
  await pills.getByRole('button', { name: 'Spending', exact: true }).click();
  await expect(page).toHaveURL(/type=EXPENSE/);

  await page.getByTestId('mobile-filters-button').click();
  const dialog = page.getByRole('dialog');
  // The dialog's Spending option is the selected one.
  await expect(dialog.getByRole('button', { name: 'Spending', exact: true })).toHaveClass(/bg-ink/);
  await dialog.getByRole('button', { name: 'Income', exact: true }).click();
  await dialog.getByRole('button', { name: 'Apply' }).click();
  await expect(page).toHaveURL(/type=INCOME/);
  await expect(pills.getByRole('button', { name: 'Income', exact: true })).toHaveClass(/bg-ink/);

  await pills.getByRole('button', { name: 'All', exact: true }).click();
  await expect(page).not.toHaveURL(/type=/);
});

test('the category picker works at phone width without horizontal overflow', async ({ page }) => {
  await login(page);
  await page.goto('/transactions');

  await page.getByTestId('mobile-filters-button').click();
  const dialog = page.getByRole('dialog');
  await dialog.locator('#filter-categories').click();
  const search = dialog.getByRole('combobox', { name: 'Search categories' });
  await search.fill('rent');
  await dialog.getByRole('option', { name: 'Rent' }).click();

  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth);

  await dialog.getByRole('button', { name: 'Apply' }).click();
  await expect(dialog).toBeHidden();
  await expect(page).toHaveURL(/categoryIds=/);
  await expect(page.getByTestId('mobile-filters-button').locator('span')).toHaveText('1');
});
