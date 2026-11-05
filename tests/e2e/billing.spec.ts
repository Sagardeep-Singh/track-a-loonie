import { test, expect } from '@playwright/test';
import { signUpThenSignIn } from './fixtures/auth';

/**
 * The suite's dev server runs without STRIPE_SECRET_KEY, which is the
 * self-hosted posture: billing is off and nothing is restricted. The Free
 * plan limits themselves are covered by the service unit tests
 * (tests/unit/services/plan-gates.test.ts, entitlements.test.ts).
 */

const PASSWORD = 'a-long-enough-password';
const uniqueEmail = (tag: string): string =>
  `${tag}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;

test('a signed-out visitor sent to /upgrade signs up, signs in and lands back on it', async ({
  page,
}) => {
  const email = uniqueEmail('upgrade-return');

  await page.goto('/upgrade');
  await expect(page).toHaveURL(/\/login\?next=%2Fupgrade$/);

  await page.getByRole('link', { name: 'Create an account' }).click();
  await expect(page).toHaveURL(/\/signup\?next=%2Fupgrade$/);
  await page.getByLabel('Name').fill('Upgrade Person');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).toHaveURL(/\/login\?signup=.*&next=%2Fupgrade/);

  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page).toHaveURL(/\/upgrade$/);
  await expect(page.getByRole('heading', { name: "Upgrades aren't available here" })).toBeVisible();
});

test('a next param outside the allowlist is ignored on sign-in', async ({ page }) => {
  const email = uniqueEmail('upgrade-open-redirect');
  await signUpThenSignIn(page, { name: 'Redirect Person', email, password: PASSWORD });
  await page.context().clearCookies();

  await page.goto('/login?next=https%3A%2F%2Fevil.example');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard/);
});

test('with billing off, nothing is gated and no plan card shows', async ({ page }) => {
  await signUpThenSignIn(page, {
    name: 'Self Host Person',
    email: uniqueEmail('billing-off'),
    password: PASSWORD,
  });

  await page.goto('/settings');
  await expect(page.getByRole('heading', { name: 'Preferences' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Plan', exact: true })).toHaveCount(0);

  await page.goto('/trends');
  await expect(page.getByText('Spending trends are part of Plus')).toHaveCount(0);

  // a third account is allowed
  for (const name of ['One', 'Two', 'Three']) {
    await page.goto('/accounts');
    await page.getByRole('button', { name: 'Add an account' }).click();
    const modal = page.getByRole('dialog');
    await modal.getByLabel('Name').fill(name);
    await modal.getByRole('button', { name: 'Add account' }).click();
    await expect(modal).toBeHidden();
  }
  await expect(page.getByRole('button', { name: 'Add an account' })).toBeVisible();
  await expect(page.getByText('Free includes')).toHaveCount(0);
});
