import bcrypt from 'bcryptjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    user: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  },
}));

vi.mock('@/lib/db/prisma', () => ({ prisma: prismaMock }));

const { changePassword } = await import('@/lib/services/password');
const { ServiceValidationError } = await import('@/lib/services/common');

const CURRENT = 'current-password-1';
const NEW = 'brand-new-password-2';
// Real bcrypt (not mocked) so the compare ordering is genuinely exercised;
// low cost factor keeps fixtures fast, and compare() is cost-agnostic.
const CURRENT_HASH = bcrypt.hashSync(CURRENT, 4);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('changePassword', () => {
  it('throws when the user no longer exists', async () => {
    prismaMock.user.findUnique.mockResolvedValue(null);

    await expect(
      changePassword('user-1', { currentPassword: CURRENT, newPassword: NEW }),
    ).rejects.toThrow(ServiceValidationError);
    expect(prismaMock.user.update).not.toHaveBeenCalled();
  });

  it('rejects a change for a Google-only account with no password', async () => {
    prismaMock.user.findUnique.mockResolvedValue({ passwordHash: null });

    await expect(
      changePassword('user-1', { currentPassword: CURRENT, newPassword: NEW }),
    ).rejects.toThrow('This account signed up with Google and has no password to change.');
    expect(prismaMock.user.update).not.toHaveBeenCalled();
  });

  it('rejects an incorrect current password', async () => {
    prismaMock.user.findUnique.mockResolvedValue({ passwordHash: CURRENT_HASH });

    await expect(
      changePassword('user-1', { currentPassword: 'not-my-password', newPassword: NEW }),
    ).rejects.toThrow('Current password is incorrect.');
    expect(prismaMock.user.update).not.toHaveBeenCalled();
  });

  it('rejects a new password identical to the current one', async () => {
    prismaMock.user.findUnique.mockResolvedValue({ passwordHash: CURRENT_HASH });

    await expect(
      changePassword('user-1', { currentPassword: CURRENT, newPassword: CURRENT }),
    ).rejects.toThrow('New password must be different from your current password.');
    expect(prismaMock.user.update).not.toHaveBeenCalled();
  });

  // Ordering guard: if the same-as-current check ran before the current-password
  // check, this would report "must be different" and leak that the supplied new
  // password matches the stored one despite a failed authentication.
  it('reports the wrong current password even when the new password matches the stored hash', async () => {
    prismaMock.user.findUnique.mockResolvedValue({ passwordHash: CURRENT_HASH });

    await expect(
      changePassword('user-1', { currentPassword: 'not-my-password', newPassword: CURRENT }),
    ).rejects.toThrow('Current password is incorrect.');
    expect(prismaMock.user.update).not.toHaveBeenCalled();
  });

  it('hashes and stores the new password scoped to the user', async () => {
    prismaMock.user.findUnique.mockResolvedValue({ passwordHash: CURRENT_HASH });
    prismaMock.user.update.mockResolvedValue({ id: 'user-1' });

    const result = await changePassword('user-1', {
      currentPassword: CURRENT,
      newPassword: NEW,
    });

    expect(result).toEqual({ ok: true });
    expect(prismaMock.user.findUnique).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      select: { passwordHash: true },
    });

    const [updateArg] = prismaMock.user.update.mock.calls[0];
    expect(updateArg.where).toEqual({ id: 'user-1' });
    // revokes sessions issued before the change
    expect(updateArg.data.passwordChangedAt).toBeInstanceOf(Date);

    const storedHash = updateArg.data.passwordHash;
    expect(storedHash).not.toBe(CURRENT_HASH);
    expect(storedHash).not.toBe(NEW);
    await expect(bcrypt.compare(NEW, storedHash)).resolves.toBe(true);
    await expect(bcrypt.compare(CURRENT, storedHash)).resolves.toBe(false);
  });
});
