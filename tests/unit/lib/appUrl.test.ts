import { describe, expect, it } from 'vitest';
import { appBaseUrl } from '@/lib/http/appUrl';

const env = (vars: Record<string, string>): NodeJS.ProcessEnv => vars as NodeJS.ProcessEnv;

describe('appBaseUrl', () => {
  it('prefers BETTER_AUTH_URL, without a trailing slash', () => {
    expect(
      appBaseUrl(
        env({
          BETTER_AUTH_URL: 'https://ledger.example/',
          VERCEL_ENV: 'production',
          VERCEL_PROJECT_PRODUCTION_URL: 'other.example',
        }),
      ),
    ).toBe('https://ledger.example');
  });

  it('uses the Vercel production domain in production when BETTER_AUTH_URL is unset', () => {
    expect(
      appBaseUrl(
        env({
          VERCEL_ENV: 'production',
          VERCEL_PROJECT_PRODUCTION_URL: 'ledger.example',
          VERCEL_URL: 'ledger-abc123.vercel.app',
        }),
      ),
    ).toBe('https://ledger.example');
  });

  it('prefers the stable branch URL on a preview', () => {
    expect(
      appBaseUrl(
        env({
          VERCEL_ENV: 'preview',
          VERCEL_BRANCH_URL: 'ledger-git-fix-email.vercel.app',
          VERCEL_URL: 'ledger-abc123.vercel.app',
        }),
      ),
    ).toBe('https://ledger-git-fix-email.vercel.app');
  });

  it('ignores the branch URL in production', () => {
    expect(
      appBaseUrl(
        env({
          VERCEL_ENV: 'production',
          VERCEL_BRANCH_URL: 'ledger-git-main.vercel.app',
          VERCEL_URL: 'ledger-abc123.vercel.app',
        }),
      ),
    ).toBe('https://ledger-abc123.vercel.app');
  });

  it('falls back to the deployment URL on a preview with no branch URL', () => {
    expect(
      appBaseUrl(
        env({
          VERCEL_ENV: 'preview',
          VERCEL_PROJECT_PRODUCTION_URL: 'ledger.example',
          VERCEL_URL: 'ledger-abc123.vercel.app',
        }),
      ),
    ).toBe('https://ledger-abc123.vercel.app');
  });

  it('falls back to localhost outside Vercel with nothing set', () => {
    expect(appBaseUrl(env({}))).toBe('http://localhost:3000');
  });
});
