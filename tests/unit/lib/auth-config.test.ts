import bcrypt from 'bcryptjs';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/db/prisma', () => ({ prisma: {} }));

const { authOptions, DISABLED_PATHS } = await import('@/lib/auth/auth');

describe('authOptions', () => {
  it('verifies a bcrypt hash carried over from NextAuth', async () => {
    const legacyHash = bcrypt.hashSync('existing-password-1', 12);
    const { verify } = authOptions.emailAndPassword.password;

    await expect(verify({ hash: legacyHash, password: 'existing-password-1' })).resolves.toBe(true);
    await expect(verify({ hash: legacyHash, password: 'wrong-password' })).resolves.toBe(false);
  });

  it('hashes new passwords with bcrypt at 12 rounds', async () => {
    const hash = await authOptions.emailAndPassword.password.hash('a-new-password');

    expect(bcrypt.getRounds(hash)).toBe(12);
    await expect(bcrypt.compare('a-new-password', hash)).resolves.toBe(true);
  });

  it('keeps 7-day sessions refreshed at most daily, with no cookie cache', () => {
    expect(authOptions.session).toEqual({ expiresIn: 60 * 60 * 24 * 7, updateAge: 60 * 60 * 24 });
    expect(authOptions.session).not.toHaveProperty('cookieCache');
  });

  it("maps Better Auth's account model away from the bank Account model", () => {
    expect(authOptions.account.modelName).toBe('authAccount');
  });

  it('encrypts the OAuth tokens Google returns before storing them', () => {
    expect(authOptions.account.encryptOAuthTokens).toBe(true);
  });

  it('never lets Better Auth create users from email/password itself', () => {
    expect(authOptions.emailAndPassword.disableSignUp).toBe(true);
  });

  it.each([
    '/sign-in/email',
    '/sign-up/email',
    '/sign-in/social',
    '/request-password-reset',
    '/reset-password',
    '/change-password',
    '/delete-user',
  ])('closes %s over HTTP so callers cannot skip the server actions', (path) => {
    expect(DISABLED_PATHS).toContain(path);
  });

  it('leaves the Google callback, session and sign-out endpoints reachable', () => {
    expect(DISABLED_PATHS).not.toContain('/callback/google');
    expect(DISABLED_PATHS).not.toContain('/get-session');
    expect(DISABLED_PATHS).not.toContain('/sign-out');
  });
});
