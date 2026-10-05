import { test, expect, type Page } from '@playwright/test';

const EMAIL = process.env.ADMIN_EMAIL ?? 'dev@example.com';
const PASSWORD = process.env.ADMIN_PASSWORD ?? 'devpassword123';

// The suite default is reduced motion (playwright.config.ts); these specs are
// about the animations themselves, so they opt back in unless stated.
test.use({ reducedMotion: 'no-preference' });

const login = async (page: Page): Promise<void> => {
  await page.goto('/login');
  await page.getByLabel('Email').fill(EMAIL);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard/);
};

/** Closes the dialog from inside the page and reports whether it is still in
 * the DOM shortly after: true means an exit animation is holding it there. */
const closeAndCheckStillMounted = (page: Page, dialogName: string): Promise<boolean> =>
  page.evaluate(async (name) => {
    const selector = `[role="dialog"][aria-label="${name}"]`;
    const close = document.querySelector<HTMLButtonElement>(
      `${selector} button[aria-label="Close"]`,
    );
    close?.click();
    await new Promise((resolve) => setTimeout(resolve, 60));
    return document.querySelector(selector) !== null;
  }, dialogName);

test.describe('drawer', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('animates out before unmounting, then restores focus to its trigger', async ({ page }) => {
    await login(page);
    await page.goto('/transactions');
    const trigger = page.getByRole('button', { name: 'Add transaction' });
    await trigger.click();
    const drawer = page.getByRole('dialog', { name: 'Add transaction' });
    await expect(drawer).toBeVisible();

    expect(await closeAndCheckStillMounted(page, 'Add transaction')).toBe(true);
    await expect(drawer).toHaveCount(0);
    await expect(trigger).toBeFocused();
  });

  test('still closes on Escape', async ({ page }) => {
    await login(page);
    await page.goto('/transactions');
    await page.getByRole('button', { name: 'Add transaction' }).click();
    const drawer = page.getByRole('dialog', { name: 'Add transaction' });
    await expect(drawer).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(drawer).toHaveCount(0);
  });
});

test.describe('bottom sheet', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  const openSheet = async (page: Page): Promise<ReturnType<Page['getByRole']>> => {
    await login(page);
    await page
      .getByRole('button', { name: /\w+ \d{4}$/ })
      .first()
      .click();
    const sheet = page.getByRole('dialog', { name: 'Pick a period' });
    await expect(sheet).toBeVisible();
    // Let the slide-up settle so the handle's position is final.
    await page.waitForTimeout(500);
    return sheet;
  };

  const dragHandle = async (page: Page, distance: number): Promise<void> => {
    const box = await page.getByTestId('sheet-handle').boundingBox();
    expect(box).not.toBeNull();
    const x = box!.x + box!.width / 2;
    const y = box!.y + box!.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x, y + distance, { steps: 12 });
    await page.mouse.up();
  };

  test('dragging the handle down far enough dismisses it', async ({ page }) => {
    const sheet = await openSheet(page);
    await dragHandle(page, 160);
    await expect(sheet).toHaveCount(0);
  });

  test('a short drag springs back and keeps it open', async ({ page }) => {
    const sheet = await openSheet(page);
    await dragHandle(page, 30);
    await page.waitForTimeout(600);
    await expect(sheet).toBeVisible();
    await expect(sheet.getByRole('button', { name: 'This month' })).toBeInViewport();
  });

  test('backdrop click still closes it', async ({ page }) => {
    const sheet = await openSheet(page);
    await page.mouse.click(195, 40);
    await expect(sheet).toHaveCount(0);
  });
});

test.describe('categorize list', () => {
  test('a categorized group leaves, and Undo brings it back', async ({ page }) => {
    const payee = `E2E Motion ${Date.now()}`;
    await login(page);

    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/transactions');
    await page.getByRole('button', { name: 'Add transaction' }).click();
    const drawer = page.getByRole('dialog', { name: 'Add transaction' });
    await drawer.getByLabel('Payee').fill(payee);
    await drawer.locator('#amount').fill('4.20');
    await drawer.getByRole('button', { name: 'Save transaction' }).click();
    await expect(drawer).toHaveCount(0);

    await page.goto('/categorize');
    const card = page.getByTestId('payee-group-card').filter({ hasText: payee });
    await expect(card).toBeVisible();
    await card
      .getByRole('button')
      .filter({ hasNotText: /More|Split|Categorize all|Suggest/ })
      .first()
      .click();
    await card.getByRole('button', { name: /Categorize all 1/ }).click();

    await expect(card).toHaveCount(0);
    const toast = page.getByText('Categorized 1 transaction');
    await expect(toast).toBeVisible();
    await page.getByRole('button', { name: 'Undo' }).click();
    await expect(toast).toHaveCount(0);
    await expect(card).toBeVisible();
  });
});

test.describe('reduced motion', () => {
  test.use({ reducedMotion: 'reduce', viewport: { width: 1280, height: 800 } });

  test('the drawer still opens and fully unmounts on close', async ({ page }) => {
    await login(page);
    await page.goto('/transactions');
    await page.getByRole('button', { name: 'Add transaction' }).click();
    const drawer = page.getByRole('dialog', { name: 'Add transaction' });
    await expect(drawer).toBeVisible();
    await drawer.getByRole('button', { name: 'Close' }).click();
    await expect(drawer).toHaveCount(0);
  });

  test('the Settings palette pill still switches', async ({ page }) => {
    await login(page);
    await page.goto('/settings');
    const cobalt = page.getByRole('button', { name: 'Cobalt', exact: true });
    await cobalt.click();
    await expect(page.locator('html')).toHaveAttribute('data-pal', 'cobalt');
    await page.getByRole('button', { name: 'Clay', exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-pal', 'clay');
  });
});
