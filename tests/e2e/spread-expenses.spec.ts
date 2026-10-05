import { test, expect, type Page } from '@playwright/test';
import { signUpThenSignIn } from './fixtures/auth';

const PASSWORD = 'a-long-enough-password';

const uniqueEmail = (tag: string): string =>
  `${tag}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;

/**
 * A fresh user per test, so the shared dev user's budgets and totals (which
 * other specs read) never see a spread expense. Setup goes through the API
 * with the signed-in page's cookies; only the spread flow itself is driven
 * through the UI.
 */
const setUp = async (page: Page): Promise<void> => {
  await signUpThenSignIn(page, {
    name: 'Spread Person',
    email: uniqueEmail('spread'),
    password: PASSWORD,
  });
  const account = await page.request.post('/api/accounts', {
    data: { name: 'Chequing', type: 'CHECKING' },
  });
  expect(account.ok()).toBe(true);
  const category = await page.request.post('/api/categories', {
    data: { name: 'Property tax' },
  });
  expect(category.ok()).toBe(true);
  const { id: categoryId } = await category.json();
  // set in January so it repeats into every month the spread covers
  const budget = await page.request.post('/api/budgets', {
    data: { categoryId, month: 202601, limitAmount: 400 },
  });
  expect(budget.ok()).toBe(true);
};

const openAddDrawer = async (page: Page): Promise<import('@playwright/test').Locator> => {
  await page.goto('/transactions');
  await page.getByRole('button', { name: 'Add transaction' }).click();
  const drawer = page.getByRole('dialog', { name: 'Add transaction' });
  await expect(drawer).toBeVisible();
  return drawer;
};

const budgetCard = (page: Page): import('@playwright/test').Locator =>
  page.getByText(/of \$400\.00/).last();

test('spreads an annual payment across its months in budgets and the overview', async ({
  page,
}) => {
  await setUp(page);
  const drawer = await openAddDrawer(page);

  await drawer.locator('#amount').fill('3600');
  await drawer.getByLabel('Date').fill('2026-06-15');
  await drawer.getByLabel('Payee').fill('City property tax');
  await drawer.getByRole('button', { name: 'Property tax' }).click();
  await drawer.getByLabel(/Spread this cost over several months/).check();

  // defaults to the payment's own month and 12 months; move it back to January
  await expect(drawer.getByLabel('Starting')).toHaveValue('2026-06');
  await expect(drawer.getByLabel('Months', { exact: true })).toHaveValue('12');
  await drawer.getByLabel('Starting').fill('2026-01');
  await expect(drawer.getByTestId('spread-preview')).toHaveText(
    '$300.00 a month, Jan 2026 to Dec 2026',
  );

  await drawer.getByRole('button', { name: 'Save transaction' }).click();
  await expect(drawer).toBeHidden();

  // the ledger keeps the real payment, with a chip
  await page.goto('/transactions?from=2026-06-01&to=2026-06-30');
  await expect(page.getByText('City property tax').first()).toBeVisible();
  await expect(page.getByTestId('spread-chip').first()).toContainText('Spread · 12 mo');

  // March never saw the payment, yet carries its share; June carries only its share
  await page.goto('/budgets?month=202603');
  await expect(budgetCard(page)).toContainText('$300.00 of $400.00');
  await page.goto('/budgets?month=202606');
  await expect(budgetCard(page)).toContainText('$300.00 of $400.00');

  // the overview explains the share and links back to the June payment
  await page.goto('/dashboard?month=202603');
  const note = page.getByTestId('spread-note');
  await expect(note).toContainText('Includes $300.00 spread from 1 payment');
  await note.getByRole('link', { name: /City property tax/ }).click();
  await expect(page).toHaveURL(/from=2026-06-15/);
});

test('turning a spread off puts the full amount back in its payment month', async ({ page }) => {
  await setUp(page);
  const drawer = await openAddDrawer(page);
  await drawer.locator('#amount').fill('1200');
  await drawer.getByLabel('Date').fill('2026-06-15');
  await drawer.getByLabel('Payee').fill('Spread then unspread');
  await drawer.getByRole('button', { name: 'Property tax' }).click();
  await drawer.getByLabel(/Spread this cost over several months/).check();
  await drawer.getByRole('button', { name: 'Save transaction' }).click();
  await expect(drawer).toBeHidden();

  await page.goto('/budgets?month=202606');
  await expect(budgetCard(page)).toContainText('$100.00 of $400.00');

  await page.goto('/transactions?from=2026-06-01&to=2026-06-30');
  await page.getByText('Spread then unspread').first().click();
  const edit = page.getByRole('dialog', { name: 'Transaction' });
  await expect(edit).toBeVisible();
  await edit.getByLabel(/Spread this cost over several months/).uncheck();
  await edit.getByRole('button', { name: 'Save changes' }).click();
  await expect(edit).toBeHidden();

  await page.goto('/budgets?month=202606');
  await expect(page.getByText(/Over by \$800\.00/).first()).toBeVisible();
  await page.goto('/budgets?month=202607');
  await expect(budgetCard(page)).toContainText('$0.00 of $400.00');
});

test('reimbursable and spread cannot both be on', async ({ page }) => {
  await setUp(page);
  const drawer = await openAddDrawer(page);
  await drawer.locator('#amount').fill('50');

  const spread = drawer.getByLabel(/Spread this cost over several months/);
  const reimbursable = drawer.getByLabel(/This expense will be paid back to me/);

  await spread.check();
  await expect(reimbursable).toBeDisabled();
  await spread.uncheck();

  await reimbursable.check();
  await expect(spread).toBeDisabled();
});

test('rejects an out-of-range month count without saving', async ({ page }) => {
  await setUp(page);
  const drawer = await openAddDrawer(page);
  await drawer.locator('#amount').fill('90');
  await drawer.getByLabel('Payee').fill('Bad spread');
  await drawer.getByLabel(/Spread this cost over several months/).check();
  // bypass the native min/max so the form's own check runs
  await drawer.getByLabel('Months', { exact: true }).evaluate((el: HTMLInputElement) => {
    el.removeAttribute('min');
    el.removeAttribute('max');
  });
  await drawer.getByLabel('Months', { exact: true }).fill('1');
  await drawer.getByRole('button', { name: 'Save transaction' }).click();

  await expect(drawer.getByRole('alert')).toContainText('Pick a start month and 2 to 24 months');
  await expect(drawer).toBeVisible();
});
