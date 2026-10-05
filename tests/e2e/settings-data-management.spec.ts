import { test, expect, type Page } from '@playwright/test';
import { signUpThenSignIn } from './fixtures/auth';

const uniqueEmail = (tag: string): string =>
  `${tag}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;

const PASSWORD = 'a-long-enough-password';

const signUpFreshUser = async (page: Page, tag: string): Promise<string> => {
  const email = uniqueEmail(tag);
  await signUpThenSignIn(page, { name: 'Data Management Person', email, password: PASSWORD });
  return email;
};

const addAccountAndTransaction = async (
  page: Page,
  { accountName, payee }: { accountName: string; payee: string },
): Promise<void> => {
  await page.goto('/accounts');
  await page.getByRole('button', { name: 'Add an account' }).click();
  // accounts-view.tsx's account form uses `Modal`, which has no
  // aria-labelledby (a known gap), so it carries no accessible name.
  const modal = page.getByRole('dialog');
  await expect(modal).toBeVisible();
  await modal.getByLabel('Name').fill(accountName);
  await modal.getByRole('button', { name: 'Add account' }).click();
  await expect(modal).toBeHidden();

  await page.goto('/transactions');
  await page.getByRole('button', { name: 'Add transaction' }).click();
  const txDrawer = page.getByRole('dialog', { name: 'Add transaction' });
  await expect(txDrawer).toBeVisible();
  await txDrawer.getByLabel('Payee').fill(payee);
  await txDrawer.locator('#amount').fill('12.34');
  await txDrawer.getByRole('button', { name: 'Save transaction' }).click();
  await expect(txDrawer).toBeHidden();
};

test('exporting downloads a JSON file containing the account data', async ({ page }) => {
  await signUpFreshUser(page, 'export');
  const accountName = `Export Test Account ${Date.now()}`;
  const payee = `Export Test Payee ${Date.now()}`;
  await addAccountAndTransaction(page, { accountName, payee });

  await page.goto('/settings');
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export my data' }).click();
  const download = await downloadPromise;

  expect(download.suggestedFilename()).toMatch(/^trackaloonie-data-\d{4}-\d{2}-\d{2}\.json$/);
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  const file = JSON.parse(Buffer.concat(chunks).toString('utf-8'));

  expect(file.formatVersion).toBe(2);
  expect(file.data.accounts.some((a: { name: string }) => a.name === accountName)).toBe(true);
  expect(file.data.transactions.some((t: { payee: string | null }) => t.payee === payee)).toBe(
    true,
  );
  expect(JSON.stringify(file)).not.toContain('passwordHash');
});

test('importing replaces the account data and reports the new counts', async ({ page }) => {
  await signUpFreshUser(page, 'import-src');
  const accountName = `Import Source Account ${Date.now()}`;
  const payee = `Import Source Payee ${Date.now()}`;
  await addAccountAndTransaction(page, { accountName, payee });

  await page.goto('/settings');
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export my data' }).click();
  const download = await downloadPromise;
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  const fileBuffer = Buffer.concat(chunks);

  // Sign up a second, empty user and import the first user's export into it —
  // a clean way to exercise "replace everything" without depending on this
  // account's own prior state.
  await page.goto('/login');
  await page.context().clearCookies();
  await signUpFreshUser(page, 'import-dst');

  await page.goto('/settings');
  await page.setInputFiles('#import-file', {
    name: 'export.json',
    mimeType: 'application/json',
    buffer: fileBuffer,
  });
  await page.getByRole('button', { name: 'Import' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Replace data' }).click();
  await expect(dialog).toBeHidden();

  await expect(page.getByText(/Import complete — replaced your data with/)).toBeVisible();

  await page.goto('/transactions');
  await expect(page.locator('.ledger-row').filter({ hasText: payee })).toBeVisible();
  await page.goto('/accounts');
  await expect(page.getByRole('main').getByText(accountName)).toBeVisible();
});

test('importing rejects a malformed file with no changes applied', async ({ page }) => {
  await signUpFreshUser(page, 'import-bad');
  await page.goto('/settings');

  await page.setInputFiles('#import-file', {
    name: 'not-an-export.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({ hello: 'world' })),
  });
  await page.getByRole('button', { name: 'Import' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Replace data' }).click();

  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByText(/Import complete/)).toHaveCount(0);
});

test('deleting an account requires the exact confirm email and password, then signs out and blocks further access', async ({
  page,
}) => {
  const email = await signUpFreshUser(page, 'delete');
  await page.goto('/settings');

  const deleteButton = page.getByRole('button', { name: 'Delete account' });
  await expect(deleteButton).toBeDisabled();

  await page.getByLabel(`Type ${email} to confirm`).fill('wrong@example.com');
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await expect(deleteButton).toBeDisabled();

  await page.getByLabel(`Type ${email} to confirm`).fill(email);
  await expect(deleteButton).toBeEnabled();

  await deleteButton.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Delete account' }).click();

  await expect(page).toHaveURL(/\/login\?accountDeleted=1/);

  // The signed-out flow clears the cookie itself; separately verify the
  // stale-JWT guard (decision 6) by hitting the DELETE route directly on a
  // *second* fresh account so the session cookie survives the call, then
  // confirming a protected page still redirects.
});

test('a deleted user is redirected even if their session cookie is still present', async ({
  page,
}) => {
  const email = await signUpFreshUser(page, 'stale-jwt');
  await page.goto('/settings');

  const deleteButton = page.getByRole('button', { name: 'Delete account' });
  await page.getByLabel(`Type ${email} to confirm`).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await expect(deleteButton).toBeEnabled();

  // Call the API directly instead of through the UI, so the client-side
  // signOutAfterAccountDeletion() (which would clear the cookie itself)
  // never runs — this isolates the jwt callback's own stale-user check.
  const res = await page.request.delete('/api/settings/account', {
    data: { confirmEmail: email, currentPassword: PASSWORD },
  });
  expect(res.ok()).toBe(true);

  await page.goto('/dashboard');
  await expect(page).toHaveURL(/\/login/);
});
