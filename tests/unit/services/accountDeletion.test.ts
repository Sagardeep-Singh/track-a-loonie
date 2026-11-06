import bcrypt from 'bcryptjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { prismaMock, wipeUserDataMock, getPasswordHashMock } = vi.hoisted(() => ({
  prismaMock: {
    user: { findUnique: vi.fn(), delete: vi.fn() },
    $transaction: vi.fn(),
  },
  wipeUserDataMock: vi.fn(),
  getPasswordHashMock: vi.fn(),
}));

vi.mock('@/lib/db/prisma', () => ({ prisma: prismaMock }));
vi.mock('@/lib/services/userData', () => ({ wipeUserData: wipeUserDataMock }));
vi.mock('@/lib/services/users', () => ({ getPasswordHash: getPasswordHashMock }));

const { deleteUserAccount } = await import('@/lib/services/accountDeletion');
const { ServiceValidationError, GoogleReauthRequiredError } = await import('@/lib/services/common');

const PASSWORD = 'current-password-1';
const PASSWORD_HASH = bcrypt.hashSync(PASSWORD, 4);

/** An existing user with this email and password hash (null = Google-only). */
const givenUser = (passwordHash: string | null): void => {
  prismaMock.user.findUnique.mockResolvedValue({ email: 'a@example.com' });
  getPasswordHashMock.mockResolvedValue(passwordHash);
};

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.$transaction.mockImplementation(
    async (fn: (tx: typeof prismaMock) => Promise<unknown>) => fn(prismaMock),
  );
});

describe('deleteUserAccount', () => {
  it('throws when the user no longer exists', async () => {
    prismaMock.user.findUnique.mockResolvedValue(null);

    await expect(
      deleteUserAccount('user-1', { confirmEmail: 'a@example.com' }, null),
    ).rejects.toThrow(ServiceValidationError);
    expect(wipeUserDataMock).not.toHaveBeenCalled();
  });

  it('rejects a mismatched confirm email, case/whitespace-insensitively matched correctly', async () => {
    givenUser(PASSWORD_HASH);

    await expect(
      deleteUserAccount(
        'user-1',
        { confirmEmail: 'wrong@example.com', currentPassword: PASSWORD },
        null,
      ),
    ).rejects.toThrow('The email you typed does not match your account email.');
    expect(wipeUserDataMock).not.toHaveBeenCalled();
  });

  it('accepts a confirm email that only differs by case/whitespace', async () => {
    givenUser(PASSWORD_HASH);
    prismaMock.user.delete.mockResolvedValue({ id: 'user-1' });

    await expect(
      deleteUserAccount(
        'user-1',
        { confirmEmail: '  A@Example.com  ', currentPassword: PASSWORD },
        null,
      ),
    ).resolves.toEqual({ ok: true });
  });

  describe('a credentials account (has a password)', () => {
    it('rejects a wrong password', async () => {
      givenUser(PASSWORD_HASH);

      await expect(
        deleteUserAccount(
          'user-1',
          { confirmEmail: 'a@example.com', currentPassword: 'not-my-password' },
          null,
        ),
      ).rejects.toThrow('Password is incorrect.');
      expect(wipeUserDataMock).not.toHaveBeenCalled();
    });

    it('rejects a missing password', async () => {
      givenUser(PASSWORD_HASH);

      await expect(
        deleteUserAccount('user-1', { confirmEmail: 'a@example.com' }, null),
      ).rejects.toThrow('Password is incorrect.');
    });

    it('wipes data and deletes the user, scoped by userId, in one transaction', async () => {
      givenUser(PASSWORD_HASH);
      prismaMock.user.delete.mockResolvedValue({ id: 'user-1' });

      const result = await deleteUserAccount(
        'user-1',
        { confirmEmail: 'a@example.com', currentPassword: PASSWORD },
        null,
      );

      expect(result).toEqual({ ok: true });
      expect(wipeUserDataMock).toHaveBeenCalledWith(prismaMock, 'user-1');
      expect(prismaMock.user.delete).toHaveBeenCalledWith({ where: { id: 'user-1' } });
      const [, options] = prismaMock.$transaction.mock.calls[0];
      expect(options).toEqual({ timeout: 30_000, maxWait: 10_000 });
    });
  });

  describe('a Google-only account (no password)', () => {
    it('rejects with no Google reauth at all', async () => {
      givenUser(null);

      await expect(
        deleteUserAccount('user-1', { confirmEmail: 'a@example.com' }, null),
      ).rejects.toThrow(GoogleReauthRequiredError);
      expect(wipeUserDataMock).not.toHaveBeenCalled();
    });

    it('rejects a reauth older than the 5-minute window', async () => {
      givenUser(null);
      const sixMinutesAgo = Date.now() - 6 * 60 * 1000;

      await expect(
        deleteUserAccount('user-1', { confirmEmail: 'a@example.com' }, sixMinutesAgo),
      ).rejects.toThrow(GoogleReauthRequiredError);
      expect(wipeUserDataMock).not.toHaveBeenCalled();
    });

    it('succeeds with no password, given a fresh Google reauth', async () => {
      givenUser(null);
      prismaMock.user.delete.mockResolvedValue({ id: 'user-1' });
      const justNow = Date.now() - 30_000;

      const result = await deleteUserAccount('user-1', { confirmEmail: 'a@example.com' }, justNow);

      expect(result).toEqual({ ok: true });
      expect(wipeUserDataMock).toHaveBeenCalledWith(prismaMock, 'user-1');
      expect(prismaMock.user.delete).toHaveBeenCalledWith({ where: { id: 'user-1' } });
    });

    it('ignores any client-supplied currentPassword and still requires a fresh Google reauth', async () => {
      givenUser(null);

      await expect(
        deleteUserAccount(
          'user-1',
          { confirmEmail: 'a@example.com', currentPassword: 'irrelevant' },
          null,
        ),
      ).rejects.toThrow(GoogleReauthRequiredError);
    });
  });
});
