import { test, expect } from '@playwright/test';
import { signUpThenSignIn } from './fixtures/auth';

const uniqueEmail = (tag: string): string =>
  `${tag}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;

const PASSWORD = 'a-long-enough-password';
const NEW_PASSWORD = 'a-different-long-password';

test('changing the password signs out the account on every other device', async ({
  page,
  browser,
}) => {
  const email = uniqueEmail('sessions');
  await signUpThenSignIn(page, { name: 'Session Person', email, password: PASSWORD });

  // A second device, signed in to the same account.
  const otherDevice = await browser.newContext();
  const otherPage = await otherDevice.newPage();
  await otherPage.goto('/login');
  await otherPage.getByLabel('Email').fill(email);
  await otherPage.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await otherPage.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(otherPage).toHaveURL(/\/dashboard/);

  await page.goto('/settings');
  await page.getByLabel('Current password').fill(PASSWORD);
  await page.getByLabel('New password', { exact: true }).fill(NEW_PASSWORD);
  await page.getByLabel('Confirm new password').fill(NEW_PASSWORD);
  await page.getByRole('button', { name: 'Change password' }).click();
  await expect(page).toHaveURL(/\/login\?passwordChanged=1/);

  await otherPage.goto('/dashboard');
  await expect(otherPage).toHaveURL(/\/login/);
  await otherDevice.close();
});

test('the email sign-in endpoint is not reachable directly, so the login rate limits cannot be skipped', async ({
  request,
}) => {
  const res = await request.post('/api/auth/sign-in/email', {
    data: { email: 'dev@example.com', password: 'devpassword123' },
  });
  expect(res.status()).toBe(404);
});
