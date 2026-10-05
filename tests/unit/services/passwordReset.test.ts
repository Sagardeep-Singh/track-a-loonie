import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';

const { prismaMock, sendEmailMock, isEmailConfiguredMock, checkRateLimitMock, bcryptHashMock } =
  vi.hoisted(() => ({
    prismaMock: {
      passwordResetToken: {
        upsert: vi.fn(),
        findUnique: vi.fn(),
        delete: vi.fn(),
      },
      user: {
        update: vi.fn(),
        findUnique: vi.fn(),
      },
      $transaction: vi.fn(),
    },
    sendEmailMock: vi.fn(),
    isEmailConfiguredMock: vi.fn(),
    checkRateLimitMock: vi.fn(),
    bcryptHashMock: vi.fn(),
  }));

vi.mock('@/lib/db/prisma', () => ({ prisma: prismaMock }));
vi.mock('bcryptjs', () => ({ default: { hash: bcryptHashMock } }));
vi.mock('@/lib/services/rateLimit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/services/rateLimit')>()),
  checkRateLimit: checkRateLimitMock,
}));
vi.mock('@/lib/email/brevo', () => ({
  sendEmail: sendEmailMock,
  isEmailConfigured: isEmailConfiguredMock,
}));

const { requestPasswordReset, getPasswordResetTokenStatus, resetPassword } =
  await import('@/lib/services/passwordReset');
const { RateLimitedError } = await import('@/lib/services/rateLimit');
const { ServiceValidationError } = await import('@/lib/services/common');

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

const HOUR_MS = 60 * 60 * 1000;

beforeEach(() => {
  vi.clearAllMocks();
  isEmailConfiguredMock.mockReturnValue(true);
  checkRateLimitMock.mockResolvedValue(undefined);
  sendEmailMock.mockResolvedValue(undefined);
  bcryptHashMock.mockResolvedValue('new-hash');
  prismaMock.$transaction.mockImplementation(async (ops: Promise<unknown>[]) => Promise.all(ops));
});

describe('requestPasswordReset', () => {
  it('does nothing when email is not configured', async () => {
    isEmailConfiguredMock.mockReturnValue(false);

    await requestPasswordReset('a@b.com');

    expect(checkRateLimitMock).not.toHaveBeenCalled();
    expect(prismaMock.user.findUnique).not.toHaveBeenCalled();
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('rate limits per lowercased address', async () => {
    prismaMock.user.findUnique.mockResolvedValue(null);

    await requestPasswordReset('A@B.com');

    expect(checkRateLimitMock).toHaveBeenCalledWith('password-reset:email', 'a@b.com', 3, HOUR_MS);
  });

  it('skips silently when the address is over its limit', async () => {
    checkRateLimitMock.mockRejectedValue(new RateLimitedError(1000));

    await expect(requestPasswordReset('a@b.com')).resolves.toBeUndefined();

    expect(prismaMock.user.findUnique).not.toHaveBeenCalled();
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('sends nothing for an unknown address', async () => {
    prismaMock.user.findUnique.mockResolvedValue(null);

    await requestPasswordReset('nobody@b.com');

    expect(prismaMock.passwordResetToken.upsert).not.toHaveBeenCalled();
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('sends the "use Google" notice and issues no token for a Google-only account', async () => {
    prismaMock.user.findUnique.mockResolvedValue({
      id: 'user-1',
      email: 'g@b.com',
      passwordHash: null,
    });

    await requestPasswordReset('g@b.com');

    expect(prismaMock.passwordResetToken.upsert).not.toHaveBeenCalled();
    expect(sendEmailMock).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'g@b.com', subject: expect.stringContaining('Google') }),
    );
  });

  it('stores only the token hash, with a 1h expiry, and emails the raw token', async () => {
    vi.useFakeTimers({ now: new Date('2026-10-05T12:00:00Z') });
    prismaMock.user.findUnique.mockResolvedValue({
      id: 'user-1',
      email: 'a@b.com',
      passwordHash: 'old-hash',
    });

    await requestPasswordReset('a@b.com');
    vi.useRealTimers();

    const upsertArgs = prismaMock.passwordResetToken.upsert.mock.calls[0]![0];
    expect(upsertArgs.where).toEqual({ userId: 'user-1' });
    expect(upsertArgs.create.expiresAt).toEqual(new Date('2026-10-05T13:00:00Z'));

    const email = sendEmailMock.mock.calls[0]![0];
    expect(email.to).toBe('a@b.com');
    expect(email.subject).toBe('Reset your Track a Loonie password');
    const rawToken = email.text.match(/token=([a-f0-9]+)/)![1];
    expect(rawToken).toHaveLength(64);
    expect(upsertArgs.create.tokenHash).toBe(sha256(rawToken));
    expect(upsertArgs.update.tokenHash).toBe(sha256(rawToken));
    expect(email.text).not.toContain(upsertArgs.create.tokenHash);
  });

  it('propagates a send failure to the caller', async () => {
    prismaMock.user.findUnique.mockResolvedValue({
      id: 'user-1',
      email: 'a@b.com',
      passwordHash: 'old-hash',
    });
    sendEmailMock.mockRejectedValue(new Error('brevo down'));

    await expect(requestPasswordReset('a@b.com')).rejects.toThrow('brevo down');
  });
});

describe('getPasswordResetTokenStatus', () => {
  it('looks the token up by its hash', async () => {
    prismaMock.passwordResetToken.findUnique.mockResolvedValue(null);

    await getPasswordResetTokenStatus('raw');

    expect(prismaMock.passwordResetToken.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tokenHash: sha256('raw') } }),
    );
  });

  it('returns invalid for an unknown token', async () => {
    prismaMock.passwordResetToken.findUnique.mockResolvedValue(null);

    expect(await getPasswordResetTokenStatus('raw')).toBe('invalid');
  });

  it('returns expired once past expiresAt', async () => {
    prismaMock.passwordResetToken.findUnique.mockResolvedValue({
      expiresAt: new Date(Date.now() - 1000),
    });

    expect(await getPasswordResetTokenStatus('raw')).toBe('expired');
  });

  it('returns valid before expiresAt', async () => {
    prismaMock.passwordResetToken.findUnique.mockResolvedValue({
      expiresAt: new Date(Date.now() + HOUR_MS),
    });

    expect(await getPasswordResetTokenStatus('raw')).toBe('valid');
  });
});

describe('resetPassword', () => {
  const input = { token: 'raw', newPassword: 'a-long-enough-password' };

  it('throws a validation error for an unknown token', async () => {
    prismaMock.passwordResetToken.findUnique.mockResolvedValue(null);

    await expect(resetPassword(input)).rejects.toThrow(ServiceValidationError);
    await expect(resetPassword(input)).rejects.toThrow('invalid or has already been used');
    expect(prismaMock.user.update).not.toHaveBeenCalled();
  });

  it('deletes an expired token and throws without touching the password', async () => {
    prismaMock.passwordResetToken.findUnique.mockResolvedValue({
      userId: 'user-1',
      expiresAt: new Date(Date.now() - 1000),
      user: { emailVerified: null },
    });

    await expect(resetPassword(input)).rejects.toThrow('has expired');

    expect(prismaMock.passwordResetToken.delete).toHaveBeenCalledWith({
      where: { userId: 'user-1' },
    });
    expect(prismaMock.user.update).not.toHaveBeenCalled();
  });

  it('hashes the new password, deletes the token and marks an unverified email verified', async () => {
    prismaMock.passwordResetToken.findUnique.mockResolvedValue({
      userId: 'user-1',
      expiresAt: new Date(Date.now() + HOUR_MS),
      user: { emailVerified: null },
    });

    await expect(resetPassword(input)).resolves.toEqual({ ok: true });

    expect(bcryptHashMock).toHaveBeenCalledWith('a-long-enough-password', 12);
    expect(prismaMock.passwordResetToken.delete).toHaveBeenCalledWith({
      where: { tokenHash: sha256('raw') },
    });
    expect(prismaMock.user.update).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      data: { passwordHash: 'new-hash', emailVerified: expect.any(Date) },
    });
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
  });

  it('leaves an existing emailVerified date alone', async () => {
    prismaMock.passwordResetToken.findUnique.mockResolvedValue({
      userId: 'user-1',
      expiresAt: new Date(Date.now() + HOUR_MS),
      user: { emailVerified: new Date('2026-01-01') },
    });

    await resetPassword(input);

    expect(prismaMock.user.update).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      data: { passwordHash: 'new-hash' },
    });
  });

  it('reports a link used concurrently as invalid rather than a raw Prisma error', async () => {
    prismaMock.passwordResetToken.findUnique.mockResolvedValue({
      userId: 'user-1',
      expiresAt: new Date(Date.now() + HOUR_MS),
      user: { emailVerified: null },
    });
    prismaMock.$transaction.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('not found', {
        code: 'P2025',
        clientVersion: 'test',
      }),
    );

    await expect(resetPassword(input)).rejects.toThrow(ServiceValidationError);
  });
});
