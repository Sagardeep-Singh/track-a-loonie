import { defineConfig, devices } from '@playwright/test';

/**
 * The BYOK AI specs need the Next.js server's *outbound* provider calls pointed
 * at a local fixture (see tests/e2e/fixtures/ai-provider-server.ts) —
 * `page.route()` cannot reach those, since they happen server-side. The two
 * base URLs and the encryption master key are therefore supplied to the dev
 * server here. Both are test-only values; `SECRET_ENCRYPTION_KEY` below is a
 * throwaway, deliberately not a real secret.
 *
 * Heads up: `reuseExistingServer` is on outside CI, so a dev server you started
 * by hand gets reused *without* these vars — the AI specs would then try to
 * reach the real provider APIs. Stop any hand-started `npm run dev` before
 * running the suite.
 */
const AI_FIXTURE_PORT = Number(process.env.AI_FIXTURE_PORT ?? 4599);
const AI_FIXTURE_URL = `http://127.0.0.1:${AI_FIXTURE_PORT}`;
const E2E_SECRET_ENCRYPTION_KEY =
  process.env.SECRET_ENCRYPTION_KEY ?? 'ZTJlLW9ubHktdGhyb3dhd2F5LWtleS0zMmJ5dGVzISE=';

/**
 * Same reasoning as the AI fixture above, for the email-verification specs:
 * the send happens server-side (lib/email/brevo.ts), so it needs its own
 * local stand-in rather than a `page.route()` intercept.
 */
const BREVO_FIXTURE_PORT = Number(process.env.BREVO_FIXTURE_PORT ?? 4598);
const BREVO_FIXTURE_URL = `http://127.0.0.1:${BREVO_FIXTURE_PORT}`;

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: 'http://localhost:3000',
    trace: 'on-first-retry',
    // Exit and layout animations keep elements in the DOM for a few hundred
    // ms; reduced motion keeps specs deterministic. animations.spec.ts opts
    // back in to test the animations themselves.
    reducedMotion: 'reduce',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'npx tsx tests/e2e/fixtures/ai-provider-server.ts',
      url: `${AI_FIXTURE_URL}/__control/health`,
      reuseExistingServer: !process.env.CI,
      env: { AI_FIXTURE_PORT: String(AI_FIXTURE_PORT) },
    },
    {
      command: 'npx tsx tests/e2e/fixtures/brevo-server.ts',
      url: `${BREVO_FIXTURE_URL}/__control/health`,
      reuseExistingServer: !process.env.CI,
      env: { BREVO_FIXTURE_PORT: String(BREVO_FIXTURE_PORT) },
    },
    {
      command: 'npm run dev',
      url: 'http://localhost:3000',
      reuseExistingServer: !process.env.CI,
      env: {
        AI_ANTHROPIC_BASE_URL: AI_FIXTURE_URL,
        AI_OPENAI_BASE_URL: AI_FIXTURE_URL,
        SECRET_ENCRYPTION_KEY: E2E_SECRET_ENCRYPTION_KEY,
        BREVO_BASE_URL: BREVO_FIXTURE_URL,
        BREVO_API_KEY: 'e2e-fixture-key',
        BREVO_SENDER_EMAIL: 'noreply@e2e-fixture.test',
        // The suite logs in as the same dev user across many specs — far more
        // attempts per run than the login/signup rate limiter (lib/auth/) is
        // meant to catch. Without this, a full run trips the limiter partway
        // through and every later spec is stuck on a disabled login form.
        E2E_DISABLE_RATE_LIMIT: '1',
      },
    },
  ],
});
