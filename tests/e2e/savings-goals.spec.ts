import { test, expect, type Page } from '@playwright/test';
import { signUpThenSignIn } from './fixtures/auth';

/**
 * Runs as a fresh user so goals and limits don't leak into the shared dev
 * user's Budgets screen that other specs assert on.
 */
const today = (): string => new Date().toISOString().slice(0, 10);

const MONTH_NAME = new Intl.DateTimeFormat('en-US', {
  timeZone: 'UTC',
  month: 'long',
  year: 'numeric',
});

/** picks the month `offset` months from now in the goal form's month picker */
const pickMonth = async (page: Page, offset: number): Promise<void> => {
  const now = new Date();
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1));
  const picker = page.getByRole('group', { name: 'Reach it by' });
  for (let year = now.getUTCFullYear(); year < date.getUTCFullYear(); year += 1) {
    await picker.getByRole('button', { name: 'Next year' }).click();
  }
  await picker.getByRole('button', { name: MONTH_NAME.format(date), exact: true }).click();
};

const freshUser = async (page: Page): Promise<void> => {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await signUpThenSignIn(page, {
    name: 'Goals',
    email: `goals-${stamp}@example.com`,
    password: 'goals-password-123',
  });
};

test('savings goal: create, contribute, spend from it, delete', async ({ page }) => {
  await freshUser(page);
  const chequing = await (
    await page.request.post('/api/accounts', {
      data: { name: 'Chequing', type: 'CHECKING', startingBalance: 5000 },
    })
  ).json();

  await page.goto('/budgets');
  await expect(page.getByText('No savings goals yet.')).toBeVisible();

  // $1,200 over 12 months (this month plus 11) is $100 a month
  await expect(page.getByTestId('savings-goals-shortcut')).toContainText('Set a savings goal');
  await page.getByRole('button', { name: 'New goal' }).click();
  await page.getByLabel('New category name').fill('Trip to Japan');
  await page.getByLabel('Target amount').fill('1200');
  // months before this one can't be picked
  const lastMonth = new Date();
  lastMonth.setUTCDate(1);
  lastMonth.setUTCMonth(lastMonth.getUTCMonth() - 1);
  if (lastMonth.getUTCFullYear() === new Date().getUTCFullYear()) {
    await expect(
      page
        .getByRole('group', { name: 'Reach it by' })
        .getByRole('button', { name: MONTH_NAME.format(lastMonth), exact: true }),
    ).toBeDisabled();
  }
  await pickMonth(page, 11);
  await expect(page.getByText('About $100.00 a month for 12 months')).toBeVisible();
  await page.getByRole('button', { name: 'Add goal' }).click();

  const card = page.getByTestId('goal-Trip to Japan');
  await expect(card).toContainText('Save $100.00 this month');
  await expect(card).toContainText('$0.00 put aside so far');
  await expect(card).toContainText('On track');

  // a transfer out of chequing tagged with the goal's category is a contribution
  const goals = await (await page.request.get('/api/savings-goals')).json();
  const tripCategoryId = goals[0].categoryId as string;
  const contribution = await page.request.post('/api/transactions', {
    data: {
      accountId: chequing.id,
      categoryId: tripCategoryId,
      amount: 150,
      type: 'EXPENSE',
      isTransfer: true,
      date: today(),
      payee: 'To savings',
    },
  });
  expect(contribution.ok()).toBe(true);

  await page.reload();
  await expect(card).toContainText('$150.00 of $1,200.00');
  await expect(card).toContainText('$150.00 put aside so far');
  await expect(page.getByTestId('savings-goals-shortcut')).toContainText(
    '1 savings goal · save $100.00 this month, $150.00 so far',
  );

  // editing happens in place on the card
  await card.getByRole('button', { name: 'Edit Trip to Japan goal' }).click();
  await card.getByLabel('Target amount').fill('2400');
  await card.getByRole('button', { name: 'Save goal' }).click();
  await expect(card).toContainText('$150.00 of $2,400.00');

  // spending from the goal is covered by what was saved, not counted as spending
  const deposit = await page.request.post('/api/transactions', {
    data: {
      accountId: chequing.id,
      categoryId: tripCategoryId,
      amount: 120,
      type: 'EXPENSE',
      date: today(),
      payee: 'Flight deposit',
    },
  });
  expect(deposit.ok()).toBe(true);
  await page.reload();
  await expect(card).toContainText('Spent $120.00 from this goal · $30.00 left');

  await page.goto('/dashboard');
  // the contribution counts as saved; the covered deposit isn't spending
  await expect(page.getByRole('link', { name: /^Saved\s*\$150\.00$/ })).toBeVisible();
  await expect(page.getByRole('link', { name: /^Out\s*\$0\.00$/ })).toBeVisible();
  await expect(page.getByRole('link', { name: /^Net\s*-\$150\.00$/ })).toBeVisible();

  // deleting the goal keeps the category
  await page.goto('/budgets');
  await card.getByRole('button', { name: 'Delete Trip to Japan goal' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click();
  await expect(page.getByText('No savings goals yet.')).toBeVisible();
  const categories = await (await page.request.get('/api/categories')).json();
  expect(categories.some((c: { name: string }) => c.name === 'Trip to Japan')).toBe(true);
});

test('savings goal: a category takes a goal or a spending limit, not both', async ({ page }) => {
  await freshUser(page);
  const groceries = await (
    await page.request.post('/api/categories', { data: { name: 'Groceries' } })
  ).json();
  const now = new Date();
  const month = now.getUTCFullYear() * 100 + now.getUTCMonth() + 1;
  await page.request.post('/api/budgets', {
    data: { categoryId: groceries.id, month, limitAmount: 400 },
  });

  const rejected = await page.request.post('/api/savings-goals', {
    data: { categoryId: groceries.id, targetAmount: 500, targetMonth: month },
  });
  expect(rejected.status()).toBe(400);
  expect((await rejected.json()).error).toContain('Remove the limit');

  // the picker doesn't offer a category that has a limit
  await page.goto('/budgets');
  await page.getByRole('button', { name: 'New goal' }).click();
  await expect(page.getByLabel('Category').locator('option', { hasText: 'Groceries' })).toHaveCount(
    0,
  );

  // and a goal's category can't take a limit
  const goal = await (
    await page.request.post('/api/savings-goals', {
      data: { newCategoryName: 'Emergency fund', targetAmount: 1000, targetMonth: month },
    })
  ).json();
  const limit = await page.request.post('/api/budgets', {
    data: { categoryId: goal.categoryId, month, limitAmount: 100 },
  });
  expect(limit.status()).toBe(400);

  // a target month in the past is refused with a readable message
  const past = await page.request.post('/api/savings-goals', {
    data: { newCategoryName: 'Car', targetAmount: 100, targetMonth: month - 1 },
  });
  expect(past.status()).toBe(400);
  expect((await past.json()).error).toContain('this month or later');
});

test('savings goal in zero-based mode: the monthly need is the target', async ({ page }) => {
  await freshUser(page);
  await page.request.post('/api/accounts', {
    data: { name: 'Chequing', type: 'CHECKING', startingBalance: 2000 },
  });
  const modeSet = await page.request.patch('/api/settings/budget-mode', {
    data: { mode: 'ZERO_BASED' },
  });
  expect(modeSet.ok()).toBe(true);

  await page.goto('/budgets');
  await page.getByRole('button', { name: 'New goal' }).click();
  await page.getByLabel('New category name').fill('Emergency fund');
  await page.getByLabel('Target amount').fill('600');
  await pickMonth(page, 5);
  await expect(page.getByLabel('Already saved in off-budget accounts')).toBeVisible();
  await page.getByRole('button', { name: 'Add goal' }).click();

  // $600 over 6 months: the row shows this month's need instead of a limit target
  const row = page.getByTestId('zbb-row-Emergency fund');
  await expect(row).toContainText('$100.00 needed this month');
  await expect(row.getByRole('button', { name: /target for Emergency fund/ })).toHaveCount(0);

  await page.getByRole('button', { name: 'Assign to targets' }).click();
  await expect(page.getByLabel('Assigned to Emergency fund')).toHaveValue('100.00');
  await expect(page.getByTestId('goal-Emergency fund')).toContainText('$100.00 put aside so far');
});
