import { test, expect, type Locator, type Page } from '@playwright/test';
import { signUpThenSignIn } from './fixtures/auth';

const PASSWORD = 'a-long-enough-password';

const uniqueEmail = (tag: string): string =>
  `${tag}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;

/** A fresh user per test with a chequing account and a credit card. */
const setUp = async (page: Page): Promise<{ chequingId: string; cardId: string }> => {
  await signUpThenSignIn(page, {
    name: 'Flags Person',
    email: uniqueEmail('flags'),
    password: PASSWORD,
  });
  const chequing = await page.request.post('/api/accounts', {
    data: { name: 'Chequing', type: 'CHECKING' },
  });
  expect(chequing.ok()).toBe(true);
  const card = await page.request.post('/api/accounts', {
    data: { name: 'Visa', type: 'CREDIT_CARD' },
  });
  expect(card.ok()).toBe(true);
  return { chequingId: (await chequing.json()).id, cardId: (await card.json()).id };
};

const openAddDrawer = async (page: Page): Promise<Locator> => {
  await page.goto('/transactions');
  await page.getByRole('button', { name: 'Add transaction' }).click();
  const drawer = page.getByRole('dialog', { name: 'Add transaction' });
  await expect(drawer).toBeVisible();
  return drawer;
};

test('ticking Reimbursable defaults the expected amount to the transaction amount', async ({
  page,
}) => {
  await setUp(page);
  const drawer = await openAddDrawer(page);
  await drawer.locator('#amount').fill('84.20');

  await drawer.getByLabel('Reimbursable', { exact: true }).check();
  const expected = drawer.getByLabel('Expected reimbursement');
  await expect(expected).toHaveValue('84.20');

  // follows the amount while it's untouched
  await drawer.locator('#amount').fill('90');
  await expect(expected).toHaveValue('90');

  // a figure the user typed is kept
  await expected.fill('40');
  await drawer.locator('#amount').fill('95');
  await expect(expected).toHaveValue('40');
});

test('flag labels are short and explain themselves in a popover', async ({ page }) => {
  await setUp(page);
  const drawer = await openAddDrawer(page);

  await drawer.getByRole('button', { name: 'About transfers' }).click();
  await expect(drawer.getByRole('tooltip')).toContainText('between your own accounts');
  await page.keyboard.press('Escape');
  await expect(drawer.getByRole('tooltip')).toBeHidden();
  // Escape closes the popover, not the drawer
  await expect(drawer).toBeVisible();

  await drawer.getByRole('button', { name: 'About reimbursable expenses' }).click();
  await expect(drawer.getByRole('tooltip')).toContainText('paid back to you');
});

test('card payment and transfer are mutually exclusive', async ({ page }) => {
  await setUp(page);
  const drawer = await openAddDrawer(page);
  await drawer.locator('#amount').fill('300');
  await drawer.getByRole('button', { name: 'Income', exact: true }).click();
  await drawer.getByLabel('Account').selectOption({ label: 'Visa' });

  const payment = drawer.getByLabel('Card payment', { exact: true });
  const transfer = drawer.getByLabel('Transfer', { exact: true });

  await payment.check();
  await transfer.check();
  await expect(payment).not.toBeChecked();
  await payment.check();
  await expect(transfer).not.toBeChecked();

  // the API rejects both at once
  const res = await page.request.post('/api/transactions', {
    data: {
      accountId: (await drawer.getByLabel('Account').inputValue()) as string,
      amount: 300,
      type: 'INCOME',
      date: '2026-03-01',
      isPayment: true,
      isTransfer: true,
    },
  });
  expect(res.status()).toBe(400);
});

test('a reimbursement links to the expense it pays back', async ({ page }) => {
  const { chequingId } = await setUp(page);
  const expense = await page.request.post('/api/transactions', {
    data: {
      accountId: chequingId,
      amount: 120,
      type: 'EXPENSE',
      date: '2026-03-02',
      payee: 'Conference hotel',
      isReimbursable: true,
      reimbursementExpectedAmount: 120,
    },
  });
  expect(expense.ok()).toBe(true);
  const income = await page.request.post('/api/transactions', {
    data: {
      accountId: chequingId,
      amount: 120,
      type: 'INCOME',
      date: '2026-03-20',
      payee: 'Employer repayment',
    },
  });
  expect(income.ok()).toBe(true);
  const expenseId = (await expense.json()).id;
  const incomeId = (await income.json()).id;
  const link = await page.request.post('/api/reimbursement-links', {
    data: { expenseTransactionId: expenseId, incomeTransactionId: incomeId, amount: 120 },
  });
  expect(link.ok()).toBe(true);

  await page.goto(`/transactions?from=2026-03-20&to=2026-03-20&tx=${incomeId}`);
  const drawer = page.getByRole('dialog', { name: 'Transaction' });
  await expect(drawer).toContainText('Employer repayment');
  await drawer.getByRole('link', { name: /Conference hotel/ }).click();

  await expect(page).toHaveURL(new RegExp(`from=2026-03-02&to=2026-03-02&tx=${expenseId}`));
  const expenseDrawer = page.getByRole('dialog', { name: 'Transaction' });
  await expect(expenseDrawer).toContainText('Conference hotel');
  await expect(expenseDrawer.getByLabel('Reimbursable', { exact: true })).toBeChecked();
});
