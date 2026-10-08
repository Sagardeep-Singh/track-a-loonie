import { test, expect, type Page } from '@playwright/test';
import { signUpThenSignIn } from './fixtures/auth';

const uniqueEmail = () =>
  `account-types-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;

const addAccount = async (
  page: Page,
  { name, type, startingBalance }: { name: string; type: string; startingBalance: string },
): Promise<void> => {
  await page.getByRole('button', { name: 'Add an account' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Name').fill(name);
  await dialog.getByLabel('Type').selectOption({ label: type });
  await dialog.getByLabel('Starting balance').fill(startingBalance);
  await dialog.getByRole('button', { name: 'Add account' }).click();
  await expect(dialog).toBeHidden();
};

test('registered and line of credit accounts show under their own groups', async ({ page }) => {
  await signUpThenSignIn(page, {
    name: 'Account Types',
    email: uniqueEmail(),
    password: 'a-long-enough-password',
  });
  await page.goto('/accounts');

  await addAccount(page, { name: 'My TFSA', type: 'TFSA', startingBalance: '5000' });
  await addAccount(page, { name: 'My LOC', type: 'Line of credit', startingBalance: '-1200' });

  const registered = page.getByRole('region', { name: 'Registered' });
  await expect(registered.getByText('My TFSA')).toBeVisible();
  await expect(registered.getByText('TFSA', { exact: true })).toBeVisible();

  const credit = page.getByRole('region', { name: 'Credit' });
  await expect(credit.getByText('My LOC')).toBeVisible();
  await expect(credit.getByText('Line of credit', { exact: true })).toBeVisible();
  await expect(credit.getByText('owing')).toBeVisible();

  // empty groups stay hidden
  await expect(page.getByRole('region', { name: 'Banking' })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Investment' })).toHaveCount(0);
});

test('the account type picker offers every new type', async ({ page }) => {
  await signUpThenSignIn(page, {
    name: 'Account Types',
    email: uniqueEmail(),
    password: 'a-long-enough-password',
  });
  await page.goto('/accounts');
  await page.getByRole('button', { name: 'Add an account' }).click();

  const type = page.getByRole('dialog').getByLabel('Type');
  for (const label of [
    'RRSP',
    'TFSA',
    'FHSA',
    'RESP',
    'RRIF',
    'LIRA',
    'Non-registered investment',
    'Line of credit',
  ]) {
    await expect(type.locator('option', { hasText: label })).toHaveCount(1);
  }
});
