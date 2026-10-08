import { test, expect, type Page } from '@playwright/test';

const EMAIL = process.env.ADMIN_EMAIL ?? 'dev@example.com';
const PASSWORD = process.env.ADMIN_PASSWORD ?? 'devpassword123';

const login = async (page: Page): Promise<void> => {
  await page.goto('/login');
  await page.getByLabel('Email').fill(EMAIL);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard/);
};

const chooseFile = async (page: Page, name: string, content: string): Promise<void> => {
  await page.locator('#csvfile').setInputFiles({
    name,
    mimeType: 'text/csv',
    buffer: Buffer.from(content),
  });
  await expect(page.locator('#account')).toBeVisible();
};

test('a day-first CSV is detected, and re-importing it in ISO format flags every row as a duplicate', async ({
  page,
}) => {
  await login(page);
  await page.goto('/import');

  const stamp = Date.now();
  const payeeA = `E2E DMY A ${stamp}`;
  const payeeB = `E2E DMY B ${stamp}`;

  // 13/02 can only be day-first, so no format pick is needed
  await chooseFile(
    page,
    `E2E-DMY-${stamp}.csv`,
    `Date,Amount,Payee\n13/02/2025,-12.34,${payeeA}\n14/02/2025,-56.78,${payeeB}\n`,
  );
  await expect(page.locator('#dateFormat')).toHaveValue('DMY');
  await page.getByRole('button', { name: 'Preview' }).click();
  await expect(page.getByText('2 rows parsed · 0 possible duplicates')).toBeVisible();
  await page.getByRole('button', { name: /^Import 2 rows$/ }).click();
  await expect(page.getByText(/Imported 2 transaction/)).toBeVisible();

  // same transactions from a different export of the same account
  await chooseFile(
    page,
    `E2E-ISO-${stamp}.csv`,
    `Date,Amount,Payee\n2025-02-13,-12.34,${payeeA}\n2025-02-14 09:15,-56.78,${payeeB}\n`,
  );
  await expect(page.locator('#dateFormat')).toHaveValue('YMD');
  await page.getByRole('button', { name: 'Preview' }).click();
  await expect(page.getByText('2 rows parsed · 2 possible duplicates')).toBeVisible();
});

test('dates that read both ways need a format pick before preview', async ({ page }) => {
  await login(page);
  await page.goto('/import');

  const stamp = Date.now();
  await chooseFile(
    page,
    `E2E-Ambiguous-${stamp}.csv`,
    `Date,Amount,Payee\n03/04/2025,-10.00,E2E Ambiguous ${stamp}\n`,
  );

  await expect(page.getByText('These dates read both month-first and day-first.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Preview' })).toBeDisabled();

  await page.locator('#dateFormat').selectOption('DMY');
  await page.getByRole('button', { name: 'Preview' }).click();
  await expect(page.getByRole('button', { name: /^Import 1 rows$/ })).toBeVisible();
  // 3 April, not March 4 (dates render as M/D/YYYY)
  await expect(page.locator('.ledger-row').filter({ hasText: '4/3/2025' })).toBeVisible();
});

test('rows with an unreadable date are skipped and called out', async ({ page }) => {
  await login(page);
  await page.goto('/import');

  const stamp = Date.now();
  await chooseFile(
    page,
    `E2E-BadDate-${stamp}.csv`,
    `Date,Amount,Payee\n2025-05-01,-10.00,E2E Good ${stamp}\nTotal,-10.00,\n`,
  );
  await page.getByRole('button', { name: 'Preview' }).click();

  await expect(page.getByRole('button', { name: /^Import 1 rows$/ })).toBeVisible();
  await expect(
    page.getByText(/Skipped 1 row with a date that isn.t YYYY-MM-DD \(line 3\)/),
  ).toBeVisible();
});
