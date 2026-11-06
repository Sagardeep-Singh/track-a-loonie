import { test, expect, type Page } from '@playwright/test';
import { signUpThenSignIn } from './fixtures/auth';

const uniqueEmail = () =>
  `balance-tracked-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;

const signUp = async (page: Page): Promise<void> => {
  await signUpThenSignIn(page, {
    name: 'Balance Tracked',
    email: uniqueEmail(),
    password: 'a-long-enough-password',
  });
};

const addAccount = async (
  page: Page,
  { name, type, balance }: { name: string; type: string; balance: string },
): Promise<void> => {
  await page.goto('/accounts');
  await page.getByRole('button', { name: 'Add an account' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Name').fill(name);
  await dialog.getByLabel('Type').selectOption({ label: type });
  // the label reads "Current balance" for tracked accounts, "Starting balance" otherwise
  await dialog.getByLabel(/(Current|Starting) balance/).fill(balance);
  await dialog.getByRole('button', { name: 'Add account' }).click();
  await expect(dialog).toBeHidden();
};

test('a TFSA is tracked by balance updates and logs new balances', async ({ page }) => {
  await signUp(page);
  await page.goto('/accounts');

  // tracking defaults on for a TFSA, and the on-budget toggle goes away
  await page.getByRole('button', { name: 'Add an account' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Type').selectOption({ label: 'TFSA' });
  await expect(dialog.getByLabel('Track by balance updates')).toBeChecked();
  await expect(dialog.getByLabel('Spending account')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Close' }).click();

  await addAccount(page, { name: 'My TFSA', type: 'TFSA', balance: '5000' });

  const registered = page.getByRole('region', { name: 'Registered' });
  await expect(registered.getByText('$5,000.00')).toBeVisible();
  await expect(registered.getByText(/Balance updated/)).toBeVisible();

  // log a new balance from the card
  await registered.getByRole('button', { name: 'Log balance' }).click();
  const logDialog = page.getByRole('dialog');
  await expect(logDialog.getByRole('heading', { name: 'Log balance · My TFSA' })).toBeVisible();
  await logDialog.getByLabel('New balance').fill('5500');
  await logDialog.getByLabel('Note (optional)').fill('Monthly check');
  await logDialog.getByRole('button', { name: 'Log balance' }).click();
  await expect(logDialog).toBeHidden();
  await expect(registered.getByText('$5,500.00')).toBeVisible();

  // the detail page shows the history, the change and the log
  await registered.getByRole('link', { name: 'My TFSA' }).click();
  await expect(page).toHaveURL(/\/accounts\/[^/?]+$/);
  await expect(page.getByRole('heading', { name: 'My TFSA' })).toBeVisible();
  const history = page.getByRole('region', { name: 'Balance history' });
  await expect(history.getByRole('img', { name: /My TFSA balance/ })).toBeVisible();

  // each update shows how much it moved since the one before
  const log = page.getByRole('region', { name: 'Balance updates' });
  const latest = log.getByRole('listitem').filter({ hasText: 'Monthly check' });
  await expect(latest.getByText('+$500.00')).toBeVisible();
  await expect(log.getByRole('listitem')).toHaveCount(2);

  // deleting the latest update falls back to the one before
  await log.getByRole('listitem').filter({ hasText: 'Monthly check' }).getByRole('button').click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click();
  await expect(log.getByRole('listitem')).toHaveCount(1);
  await expect(history.getByText('$5,000.00', { exact: true })).toBeVisible();

  // the range switcher re-renders the chart for the chosen range
  await history.getByRole('link', { name: '2Y' }).click();
  await expect(page).toHaveURL(/range=24/);
  await expect(history.getByRole('link', { name: '2Y' })).toHaveAttribute('aria-current', 'page');
  await expect(history.getByRole('img', { name: /My TFSA balance/ })).toBeVisible();
});

test('a balance-tracked account rejects a balance from the future', async ({ page }) => {
  await signUp(page);
  await addAccount(page, { name: 'Savings', type: 'Savings', balance: '100' });

  const res = await page.request.get('/api/accounts');
  const [account] = (await res.json()) as { id: string }[];
  const future = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const post = await page.request.post(`/api/accounts/${account!.id}/balance-updates`, {
    data: { balance: 200, date: future },
  });
  expect(post.status()).toBe(400);
});

test('balance-tracked accounts are left out of the transaction account picker', async ({
  page,
}) => {
  await signUp(page);
  await addAccount(page, { name: 'Chequing', type: 'Checking', balance: '1000' });
  await addAccount(page, { name: 'Retirement', type: 'RRSP', balance: '20000' });

  await page.goto('/transactions?overlay=add');
  const drawer = page.getByRole('dialog', { name: 'Log a transaction' });
  const picker = drawer.getByLabel('Account');
  await expect(picker.locator('option', { hasText: 'Chequing' })).toHaveCount(1);
  await expect(picker.locator('option', { hasText: 'Retirement' })).toHaveCount(0);

  // and the API refuses a transaction on one outright
  const accounts = (await (await page.request.get('/api/accounts')).json()) as {
    id: string;
    name: string;
  }[];
  const rrsp = accounts.find((a) => a.name === 'Retirement')!;
  const post = await page.request.post('/api/transactions', {
    data: { accountId: rrsp.id, amount: 10, type: 'INCOME', date: '2026-01-05' },
  });
  expect(post.status()).toBe(400);
});

test('a checking account and net worth chart their balance over time', async ({ page }) => {
  await signUp(page);
  await addAccount(page, { name: 'Chequing', type: 'Checking', balance: '1000' });

  await expect(
    page
      .getByRole('region', { name: 'Net worth over time' })
      .getByRole('img', { name: 'Net worth at the end of each month' }),
  ).toBeVisible();

  const banking = page.getByRole('region', { name: 'Banking' });
  await banking.getByRole('link', { name: 'History' }).click();
  const history = page.getByRole('region', { name: 'Balance history' });
  await expect(history.getByRole('img', { name: /Chequing balance/ })).toBeVisible();
  await expect(history.getByRole('link', { name: 'View transactions' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Balance updates' })).toHaveCount(0);
});

test('turning tracking on is refused while the account has transactions', async ({ page }) => {
  await signUp(page);
  await addAccount(page, { name: 'Chequing', type: 'Checking', balance: '1000' });
  const [account] = (await (await page.request.get('/api/accounts')).json()) as { id: string }[];
  await page.request.post('/api/transactions', {
    data: { accountId: account!.id, amount: 10, type: 'EXPENSE', date: '2026-01-05' },
  });

  const patch = await page.request.patch(`/api/accounts/${account!.id}`, {
    data: { tracksBalance: true },
  });
  expect(patch.status()).toBe(400);
  expect(((await patch.json()) as { error: string }).error).toMatch(/transactions/);

  // the form explains why the toggle is off-limits
  await page.reload();
  await page.getByRole('region', { name: 'Banking' }).getByRole('button', { name: 'Edit' }).click();
  await expect(page.getByRole('dialog').getByLabel('Track by balance updates')).toBeDisabled();
});
