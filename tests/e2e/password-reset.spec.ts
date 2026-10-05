import { test, expect, type Page } from '@playwright/test';
import { signUpThenSignIn } from './fixtures/auth';

const BREVO_FIXTURE_URL = `http://127.0.0.1:${process.env.BREVO_FIXTURE_PORT ?? 4598}`;

const OLD_PASSWORD = 'a-long-enough-password';
const NEW_PASSWORD = 'a-brand-new-long-password';

const uniqueEmail = () => `reset-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;

const lastEmailTo = async (to: string): Promise<{ subject: string; html: string }> => {
  const response = await fetch(`${BREVO_FIXTURE_URL}/__control/last?to=${encodeURIComponent(to)}`);
  if (!response.ok) {
    throw new Error(`no email sent to ${to} yet (status ${response.status})`);
  }
  return response.json();
};

const extractResetPath = (html: string): string => {
  const match = html.match(/\/reset-password\?token=[a-f0-9]+/);
  if (!match) throw new Error(`no reset link found in email body: ${html}`);
  return match[0];
};

const signUpThenSignOut = async (page: Page, email: string): Promise<void> => {
  await signUpThenSignIn(page, { name: 'Reset Person', email, password: OLD_PASSWORD });
  await page.context().clearCookies();
};

const requestReset = async (page: Page, email: string): Promise<void> => {
  await page.goto('/login');
  await page.getByRole('link', { name: 'Forgot password?' }).click();
  await expect(page).toHaveURL(/\/forgot-password$/);
  await page.getByLabel('Email').fill(email);
  await page.getByRole('button', { name: 'Send reset link' }).click();
  await expect(page).toHaveURL(/\/forgot-password\?sent=1/);
  await expect(page.getByText('If that email has an account')).toBeVisible();
};

const signIn = async (page: Page, email: string, password: string): Promise<void> => {
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
};

test('resets a forgotten password through the emailed link', async ({ page }) => {
  const email = uniqueEmail();
  await signUpThenSignOut(page, email);

  await requestReset(page, email);
  const sent = await lastEmailTo(email);
  expect(sent.subject).toBe('Reset your Track a Loonie password');

  await page.goto(extractResetPath(sent.html));
  await page.getByLabel('New password', { exact: true }).fill(NEW_PASSWORD);
  await page.getByLabel('Confirm new password').fill(NEW_PASSWORD);
  await page.getByRole('button', { name: 'Reset password' }).click();

  await expect(page).toHaveURL(/\/login\?passwordReset=1/);
  await expect(page.getByText('Password reset. Sign in with your new password.')).toBeVisible();

  await signIn(page, email, OLD_PASSWORD);
  await expect(page.getByText('Incorrect email or password.')).toBeVisible();

  await signIn(page, email, NEW_PASSWORD);
  await expect(page).toHaveURL(/\/dashboard/);
});

test('a mixed-case address is stored lowercase and works in any case', async ({ page }) => {
  const typedAtSignup = uniqueEmail()
    .replace('reset-', 'Reset.Mixed-')
    .replace('@example', '@Example');
  const stored = typedAtSignup.toLowerCase();
  await signUpThenSignOut(page, typedAtSignup);

  await requestReset(page, typedAtSignup.toUpperCase());

  const sent = await lastEmailTo(stored);
  expect(sent.subject).toBe('Reset your Track a Loonie password');

  await page.goto('/login');
  await signIn(page, ` ${typedAtSignup.toUpperCase()} `, OLD_PASSWORD);
  await expect(page).toHaveURL(/\/dashboard/);
});

test('an unknown email gets the same confirmation as a real one', async ({ page }) => {
  await requestReset(page, uniqueEmail());
});

test('a mismatched confirmation shows an inline error', async ({ page }) => {
  const email = uniqueEmail();
  await signUpThenSignOut(page, email);
  await requestReset(page, email);

  await page.goto(extractResetPath((await lastEmailTo(email)).html));
  await page.getByLabel('New password', { exact: true }).fill(NEW_PASSWORD);
  await page.getByLabel('Confirm new password').fill(`${NEW_PASSWORD}-typo`);
  await page.getByRole('button', { name: 'Reset password' }).click();

  await expect(page.getByText('New password and confirmation do not match.')).toBeVisible();
  await expect(page).toHaveURL(/\/reset-password\?token=/);
});

test('an invalid link shows an error with a way to request a new one', async ({ page }) => {
  await page.goto('/reset-password?token=not-a-real-token');

  await expect(
    page.getByText('This reset link is invalid or has already been used.'),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Reset password' })).toHaveCount(0);
  await page.getByRole('link', { name: 'Request a new link' }).click();
  await expect(page).toHaveURL(/\/forgot-password$/);
});

test('a used link cannot be used again', async ({ page }) => {
  const email = uniqueEmail();
  await signUpThenSignOut(page, email);
  await requestReset(page, email);
  const resetPath = extractResetPath((await lastEmailTo(email)).html);

  await page.goto(resetPath);
  await page.getByLabel('New password', { exact: true }).fill(NEW_PASSWORD);
  await page.getByLabel('Confirm new password').fill(NEW_PASSWORD);
  await page.getByRole('button', { name: 'Reset password' }).click();
  await expect(page).toHaveURL(/\/login\?passwordReset=1/);

  await page.goto(resetPath);
  await expect(
    page.getByText('This reset link is invalid or has already been used.'),
  ).toBeVisible();
});
