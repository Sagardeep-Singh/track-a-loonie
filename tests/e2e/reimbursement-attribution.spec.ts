import { test, expect, type Locator, type Page } from '@playwright/test';
import { signUpThenSignIn } from './fixtures/auth';

const PASSWORD = 'a-long-enough-password';

const uniqueEmail = (tag: string): string =>
  `${tag}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;

/**
 * A fresh user, so no other spec's budgets see these numbers. A $100 January
 * work lunch is paid back $40 in March, and March has $90 of its own spend in
 * the same category. Setup is API-driven; the setting is flipped in the UI.
 */
const setUp = async (page: Page): Promise<void> => {
  await signUpThenSignIn(page, {
    name: 'Reimbursed Person',
    email: uniqueEmail('reimburse-month'),
    password: PASSWORD,
  });
  const post = async (url: string, data: Record<string, unknown>): Promise<{ id: string }> => {
    const res = await page.request.post(url, { data });
    expect(res.ok(), `${url} ${JSON.stringify(data)}`).toBe(true);
    return (await res.json()) as { id: string };
  };
  const account = await post('/api/accounts', { name: 'Chequing', type: 'CHECKING' });
  const category = await post('/api/categories', { name: 'Work meals' });
  await post('/api/budgets', { categoryId: category.id, month: 202601, limitAmount: 400 });
  const tx = (data: Record<string, unknown>): Promise<{ id: string }> =>
    post('/api/transactions', { type: 'EXPENSE', accountId: account.id, ...data });
  const lunch = await tx({
    amount: 100,
    date: '2026-01-10',
    payee: 'Client lunch',
    categoryId: category.id,
    isReimbursable: true,
    reimbursementExpectedAmount: 100,
  });
  await tx({ amount: 90, date: '2026-03-05', payee: 'Team dinner', categoryId: category.id });
  const payback = await tx({ type: 'INCOME', amount: 40, date: '2026-03-12', payee: 'Payback' });
  await post('/api/reimbursement-links', {
    expenseTransactionId: lunch.id,
    incomeTransactionId: payback.id,
    amount: 40,
  });
};

const budgetCard = (page: Page): Locator => page.getByText(/of \$400\.00/).last();

test('a reimbursable expense stays in full in its month unless the user picks the expense month', async ({
  page,
}) => {
  await setUp(page);

  // default: both months keep their full spend; the $40 is income in March
  await page.goto('/budgets?month=202601');
  await expect(budgetCard(page)).toContainText('$100.00 of $400.00');
  await page.goto('/budgets?month=202603');
  await expect(budgetCard(page)).toContainText('$90.00 of $400.00');

  // the payback row is labelled as a reimbursement
  await page.goto('/transactions?from=2026-03-01&to=2026-03-31');
  const payback = page.locator('.ledger-row').filter({ hasText: 'Payback' });
  await expect(payback.getByTestId('transaction-badge')).toHaveText(['Reimbursement']);

  await page.goto('/settings');
  const option = page.getByRole('button', { name: 'Expense month' });
  await option.click();
  await expect(option).toHaveAttribute('aria-pressed', 'true');

  await page.goto('/budgets?month=202601');
  await expect(budgetCard(page)).toContainText('$60.00 of $400.00');
  await page.goto('/budgets?month=202603');
  await expect(budgetCard(page)).toContainText('$90.00 of $400.00');

  // and back to the default
  await page.goto('/settings');
  await page.getByRole('button', { name: 'When received' }).click();
  await expect(page.getByRole('button', { name: 'When received' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.goto('/budgets?month=202601');
  await expect(budgetCard(page)).toContainText('$100.00 of $400.00');
});
