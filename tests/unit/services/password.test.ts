import bcrypt from 'bcryptjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { prismaMock, getPasswordHashMock, replacePasswordHashMock } = vi.hoisted(() => ({
  prismaMock: {
    user: {
      findUnique: vi.fn(),
    },
    $transaction: vi.fn(),
  },
  getPasswordHashMock: vi.fn(),
  replacePasswordHashMock: vi.fn(),
}));

vi.mock('@/lib/db/prisma', () => ({ prisma: prismaMock }));
vi.mock('@/lib/services/users', () => ({
  getPasswordHash: getPasswordHashMock,
  replacePasswordHash: replacePasswordHashMock,
}));

const { changePassword } = await import('@/lib/services/password');
const { ServiceValidationError } = await import('@/lib/services/common');

const CURRENT = 'current-password-1';
const NEW = 'brand-new-password-2';
// Real bcrypt (not mocked) so the compare ordering is genuinely exercised;
// low cost factor keeps fixtures fast, and compare() is cost-agnostic.
const CURRENT_HASH = bcrypt.hashSync(CURRENT, 4);

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.user.findUnique.mockResolvedValue({ id: 'user-1' });
  prismaMock.$transaction.mockImplementation((fn: (tx: unknown) => unknown) => fn('tx'));
});

describe('changePassword', () => {
  it('throws when the user no longer exists', async () => {
    prismaMock.user.findUnique.mockResolvedValue(null);

    await expect(
      changePassword('user-1', { currentPassword: CURRENT, newPassword: NEW }),
    ).rejects.toThrow(ServiceValidationError);
    expect(replacePasswordHashMock).not.toHaveBeenCalled();
  });

  it('rejects a change for a Google-only account with no password', async () => {
    getPasswordHashMock.mockResolvedValue(null);

    await expect(
      changePassword('user-1', { currentPassword: CURRENT, newPassword: NEW }),
    ).rejects.toThrow('This account signed up with Google and has no password to change.');
    expect(replacePasswordHashMock).not.toHaveBeenCalled();
  });

  it('rejects an incorrect current password', async () => {
    getPasswordHashMock.mockResolvedValue(CURRENT_HASH);

    await expect(
      changePassword('user-1', { currentPassword: 'not-my-password', newPassword: NEW }),
    ).rejects.toThrow('Current password is incorrect.');
    expect(replacePasswordHashMock).not.toHaveBeenCalled();
  });

  it('rejects a new password identical to the current one', async () => {
    getPasswordHashMock.mockResolvedValue(CURRENT_HASH);

    await expect(
      changePassword('user-1', { currentPassword: CURRENT, newPassword: CURRENT }),
    ).rejects.toThrow('New password must be different from your current password.');
    expect(replacePasswordHashMock).not.toHaveBeenCalled();
  });

  // Ordering guard: if the same-as-current check ran before the current-password
  // check, this would report "must be different" and leak that the supplied new
  // password matches the stored one despite a failed authentication.
  it('reports the wrong current password even when the new password matches the stored hash', async () => {
    getPasswordHashMock.mockResolvedValue(CURRENT_HASH);

    await expect(
      changePassword('user-1', { currentPassword: 'not-my-password', newPassword: CURRENT }),
    ).rejects.toThrow('Current password is incorrect.');
    expect(replacePasswordHashMock).not.toHaveBeenCalled();
  });

  it('hashes and stores the new password scoped to the user, signing out its sessions', async () => {
    getPasswordHashMock.mockResolvedValue(CURRENT_HASH);

    const result = await changePassword('user-1', {
      currentPassword: CURRENT,
      newPassword: NEW,
    });

    expect(result).toEqual({ ok: true });
    expect(getPasswordHashMock).toHaveBeenCalledWith('user-1');

    const [tx, userId, storedHash] = replacePasswordHashMock.mock.calls[0];
    expect(tx).toBe('tx');
    expect(userId).toBe('user-1');
    expect(storedHash).not.toBe(CURRENT_HASH);
    expect(storedHash).not.toBe(NEW);
    await expect(bcrypt.compare(NEW, storedHash)).resolves.toBe(true);
    await expect(bcrypt.compare(CURRENT, storedHash)).resolves.toBe(false);
  });
});
