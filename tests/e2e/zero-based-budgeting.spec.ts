import { test, expect, type Page } from '@playwright/test';
import { signUpThenSignIn } from './fixtures/auth';

/**
 * Runs as a fresh user: switching the budgeting mode is per user, and the
 * shared dev user's Budgets screen is what other specs assert on.
 */
const today = (): string => new Date().toISOString().slice(0, 10);

const row = (page: Page, name: string) => page.getByTestId(`zbb-row-${name}`);

const setAssigned = async (page: Page, name: string, amount: string): Promise<void> => {
  const input = page.getByLabel(`Assigned to ${name}`);
  await input.fill(amount);
  await input.press('Enter');
  await expect(input).toBeEnabled();
};

test('zero-based budgeting: enable, assign, cover an overspend, switch back', async ({ page }) => {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await signUpThenSignIn(page, {
    name: 'ZBB',
    email: `zbb-${stamp}@example.com`,
    password: 'zbb-password-123',
  });

  const chequing = await (
    await page.request.post('/api/accounts', {
      data: { name: 'Chequing', type: 'CHECKING', startingBalance: 2000 },
    })
  ).json();
  await page.request.post('/api/accounts', {
    data: { name: 'Savings', type: 'SAVINGS', startingBalance: 5000 },
  });
  const groceries = await (
    await page.request.post('/api/categories', { data: { name: 'Groceries' } })
  ).json();
  await page.request.post('/api/categories', { data: { name: 'Fun' } });

  // Settings: savings starts off-budget in the confirm step
  await page.goto('/settings');
  await page.getByRole('button', { name: 'Zero-based', exact: true }).click();
  await expect(page.getByRole('checkbox', { name: /Chequing/ })).toBeChecked();
  await expect(page.getByRole('checkbox', { name: /Savings/ })).not.toBeChecked();
  await page.getByRole('button', { name: 'Turn on zero-based' }).click();
  await expect(page.getByRole('button', { name: 'Turn on zero-based' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Zero-based', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  // Ready to Assign is the on-budget balance only
  await page.goto('/budgets');
  const ready = page.getByTestId('ready-to-assign');
  await expect(ready).toContainText('$2,000.00');

  await setAssigned(page, 'Groceries', '1500');
  await setAssigned(page, 'Fun', '500');
  await expect(ready).toContainText('$0.00');
  await expect(ready).toContainText('All assigned');

  // overspend Groceries by $100, then cover it from Fun
  const spent = await page.request.post('/api/transactions', {
    data: {
      accountId: chequing.id,
      categoryId: groceries.id,
      amount: 1600,
      type: 'EXPENSE',
      date: today(),
      payee: 'Big shop',
    },
  });
  expect(spent.ok()).toBe(true);
  await page.reload();
  await expect(row(page, 'Groceries').getByTestId('zbb-available')).toHaveText('-$100.00');
  // spending already assigned money leaves Ready to Assign at zero
  await expect(ready).toContainText('$0.00');

  await page.goto('/dashboard');
  await expect(
    page.getByTestId('zbb-suggestion-overspent').filter({ visible: true }),
  ).toContainText('Groceries is overspent by $100.00');
  await expect(
    page.getByTestId('zbb-suggestion-overspent').filter({ visible: true }),
  ).toContainText('Cover it from Fun');
  await page.goto('/budgets');
  await row(page, 'Groceries').getByRole('button', { name: 'Cover' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('From').selectOption({ label: 'Fun ($500.00)' });
  await expect(dialog.getByLabel('Amount')).toHaveValue('100.00');
  await dialog.getByRole('button', { name: 'Move money' }).click();
  await expect(row(page, 'Groceries').getByTestId('zbb-available')).toHaveText('$0.00');
  await expect(row(page, 'Fun').getByTestId('zbb-available')).toHaveText('$400.00');

  // the Overview swaps the limits hero for zero-based cards
  await page.goto('/dashboard');
  const hero = page.getByTestId('zbb-hero').filter({ visible: true });
  await expect(hero).toContainText('All assigned');
  await expect(page.getByTestId('zbb-suggestion-all-good').filter({ visible: true })).toBeVisible();
  await expect(page.getByTestId('zbb-health-Groceries').filter({ visible: true })).toContainText(
    'On track',
  );
  await page.goto('/budgets');

  // assigning more than exists shows the error state instead of being refused
  await setAssigned(page, 'Fun', '900');
  await expect(ready).toContainText('Over-assigned');
  await expect(ready).toContainText('-$500.00');
  await setAssigned(page, 'Fun', '400');
  await expect(ready).toContainText('All assigned');

  // targets are edited in place; one the money can't cover assigns nothing
  // and names the shortfall
  await page.getByRole('button', { name: 'Set target for Groceries' }).click();
  const targetDialog = page.getByRole('dialog');
  await targetDialog.getByLabel('Monthly target').fill('5000');
  await targetDialog.getByRole('button', { name: 'Save target' }).click();
  await expect(page.getByRole('button', { name: 'Edit target for Groceries' })).toContainText(
    'target $5,000.00',
  );
  await page.getByRole('button', { name: 'Assign to targets' }).click();
  await expect(page.getByText('needs $3400.00 but only $0.00 is ready to assign')).toBeVisible();

  // lowering the target to what's already there needs nothing more
  await page.getByRole('button', { name: 'Edit target for Groceries' }).click();
  await targetDialog.getByLabel('Monthly target').fill('1600');
  await targetDialog.getByRole('button', { name: 'Save target' }).click();
  await expect(page.getByRole('button', { name: 'Edit target for Groceries' })).toContainText(
    'target $1,600.00',
  );

  // switching back shows the limits view; the limit set above is intact
  await page.goto('/settings');
  await page.getByRole('button', { name: 'Spending limits' }).click();
  await expect(page.getByRole('button', { name: 'Spending limits' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.goto('/budgets');
  await expect(
    page.getByText('A monthly limit per category. Status follows the limit, not the calendar.'),
  ).toBeVisible();
  await expect(page.getByRole('link', { name: 'Groceries' })).toBeVisible();
  await expect(page.getByTestId('ready-to-assign')).toHaveCount(0);

  // and back again: assignments were kept
  await page.goto('/settings');
  await page.getByRole('button', { name: 'Zero-based', exact: true }).click();
  await page.getByRole('button', { name: 'Turn on zero-based' }).click();
  await expect(page.getByRole('button', { name: 'Turn on zero-based' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Zero-based', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.goto('/budgets');
  await expect(page.getByLabel('Assigned to Fun')).toHaveValue('400.00');
});

test.describe('on mobile', () => {
  test.use({ viewport: { width: 402, height: 874 } });

  test('the Left pill opens Move money in a bottom sheet, and targets use one too', async ({
    page,
  }) => {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await signUpThenSignIn(page, {
      name: 'ZBB mobile',
      email: `zbb-mobile-${stamp}@example.com`,
      password: 'zbb-password-123',
    });
    await page.request.post('/api/accounts', {
      data: { name: 'Chequing', type: 'CHECKING', startingBalance: 1000 },
    });
    await page.request.post('/api/categories', { data: { name: 'Groceries' } });
    await page.request.post('/api/categories', { data: { name: 'Fun' } });
    const mode = await page.request.patch('/api/settings/budget-mode', {
      data: { mode: 'ZERO_BASED' },
    });
    expect(mode.ok()).toBe(true);

    await page.goto('/budgets');
    await setAssigned(page, 'Groceries', '300');

    // the pill is the only Move control on mobile
    await expect(row(page, 'Groceries').getByRole('button', { name: /^Move$/ })).toBeHidden();
    await row(page, 'Groceries')
      .getByRole('button', { name: 'Move money from Groceries, $300.00 left' })
      .click();
    const sheet = page.getByRole('dialog', { name: 'Move money' });
    await expect(sheet.getByTestId('sheet-handle')).toBeVisible();
    await sheet.getByLabel('To').selectOption({ label: 'Fun ($0.00)' });
    await sheet.getByLabel('Amount').fill('120');
    await sheet.getByRole('button', { name: 'Move money' }).click();
    await expect(sheet).toHaveCount(0);
    await expect(
      row(page, 'Fun').getByRole('button', { name: 'Move money from Fun, $120.00 left' }),
    ).toBeVisible();

    await page.getByRole('button', { name: 'Set target for Fun' }).click();
    const targetSheet = page.getByRole('dialog', { name: 'Target for Fun' });
    await expect(targetSheet.getByTestId('sheet-handle')).toBeVisible();
    await targetSheet.getByLabel('Monthly target').fill('150');
    await targetSheet.getByRole('button', { name: 'Save target' }).click();
    await expect(page.getByRole('button', { name: 'Edit target for Fun' })).toContainText(
      'target $150.00',
    );
  });
});
