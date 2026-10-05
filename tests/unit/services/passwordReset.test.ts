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
        findMany: vi.fn(),
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
vi.mock('@/lib/email/brevo', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/email/brevo')>()),
  sendEmail: sendEmailMock,
  isEmailConfigured: isEmailConfiguredMock,
}));

const { requestPasswordReset, getPasswordResetTokenStatus, resetPassword } =
  await import('@/lib/services/passwordReset');
const { RateLimitedError } = await import('@/lib/services/rateLimit');
const { ServiceValidationError } = await import('@/lib/services/common');
const { EmailSendError } = await import('@/lib/email/brevo');

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

const HOUR_MS = 60 * 60 * 1000;

const logSpies = {
  info: vi.spyOn(console, 'info').mockImplementation(() => {}),
  warn: vi.spyOn(console, 'warn').mockImplementation(() => {}),
  error: vi.spyOn(console, 'error').mockImplementation(() => {}),
};

const allLogs = (): string =>
  Object.values(logSpies)
    .flatMap((spy) => spy.mock.calls.flat())
    .join('\n');

beforeEach(() => {
  vi.clearAllMocks();
  isEmailConfiguredMock.mockReturnValue(true);
  checkRateLimitMock.mockResolvedValue(undefined);
  sendEmailMock.mockResolvedValue({ messageId: '<msg-1@brevo>' });
  bcryptHashMock.mockResolvedValue('new-hash');
  prismaMock.$transaction.mockImplementation(async (ops: Promise<unknown>[]) => Promise.all(ops));
});

describe('requestPasswordReset', () => {
  it('does nothing when email is not configured', async () => {
    isEmailConfiguredMock.mockReturnValue(false);

    await requestPasswordReset('a@b.com');

    expect(checkRateLimitMock).not.toHaveBeenCalled();
    expect(prismaMock.user.findMany).not.toHaveBeenCalled();
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('rate limits per lowercased address', async () => {
    prismaMock.user.findMany.mockResolvedValue([]);

    await requestPasswordReset('A@B.com');

    expect(checkRateLimitMock).toHaveBeenCalledWith('password-reset:email', 'a@b.com', 3, HOUR_MS);
  });

  it('skips silently when the address is over its limit', async () => {
    checkRateLimitMock.mockRejectedValue(new RateLimitedError(1000));

    await expect(requestPasswordReset('a@b.com')).resolves.toBeUndefined();

    expect(prismaMock.user.findMany).not.toHaveBeenCalled();
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('sends nothing for an unknown address', async () => {
    prismaMock.user.findMany.mockResolvedValue([]);

    await requestPasswordReset('nobody@b.com');

    expect(prismaMock.passwordResetToken.upsert).not.toHaveBeenCalled();
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('sends the "use Google" notice and issues no token for a Google-only account', async () => {
    prismaMock.user.findMany.mockResolvedValue([
      {
        id: 'user-1',
        email: 'g@b.com',
        passwordHash: null,
      },
    ]);

    await requestPasswordReset('g@b.com');

    expect(prismaMock.passwordResetToken.upsert).not.toHaveBeenCalled();
    expect(sendEmailMock).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'g@b.com', subject: expect.stringContaining('Google') }),
    );
  });

  it('stores only the token hash, with a 1h expiry, and emails the raw token', async () => {
    vi.useFakeTimers({ now: new Date('2026-10-05T12:00:00Z') });
    prismaMock.user.findMany.mockResolvedValue([
      {
        id: 'user-1',
        email: 'a@b.com',
        passwordHash: 'old-hash',
      },
    ]);

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
    prismaMock.user.findMany.mockResolvedValue([
      {
        id: 'user-1',
        email: 'a@b.com',
        passwordHash: 'old-hash',
      },
    ]);
    sendEmailMock.mockRejectedValue(new Error('brevo down'));

    await expect(requestPasswordReset('a@b.com')).rejects.toThrow('brevo down');
  });
});

describe('requestPasswordReset email matching', () => {
  const stored = { id: 'user-1', email: 'Jane.Doe@Example.com', passwordHash: 'old-hash' };

  it('looks the address up case-insensitively', async () => {
    prismaMock.user.findMany.mockResolvedValue([]);

    await requestPasswordReset('jane.doe@example.com');

    expect(prismaMock.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { email: { equals: 'jane.doe@example.com', mode: 'insensitive' } },
      }),
    );
  });

  it('sends to the stored address when the input differs only by case', async () => {
    prismaMock.user.findMany.mockResolvedValue([stored]);

    await requestPasswordReset('JANE.DOE@EXAMPLE.COM');

    expect(prismaMock.passwordResetToken.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 'user-1' } }),
    );
    expect(sendEmailMock).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'Jane.Doe@Example.com' }),
    );
  });

  it('prefers the exact match when two accounts differ only by case', async () => {
    prismaMock.user.findMany.mockResolvedValue([
      stored,
      { id: 'user-2', email: 'jane.doe@example.com', passwordHash: 'other-hash' },
    ]);

    await requestPasswordReset('jane.doe@example.com');

    expect(prismaMock.passwordResetToken.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 'user-2' } }),
    );
    expect(sendEmailMock).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'jane.doe@example.com' }),
    );
  });

  it('sends nothing and logs when several accounts match and none exactly', async () => {
    prismaMock.user.findMany.mockResolvedValue([
      stored,
      { id: 'user-2', email: 'jane.doe@example.com', passwordHash: 'other-hash' },
    ]);

    await requestPasswordReset('JANE.DOE@example.COM');

    expect(prismaMock.passwordResetToken.upsert).not.toHaveBeenCalled();
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(logSpies.warn).toHaveBeenCalledWith(
      '[password-reset] request.ambiguous-account matches=2',
    );
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

describe('logging', () => {
  const passwordUser = { id: 'user-1', email: 'secret@b.com', passwordHash: 'old-hash' };

  it('logs a skip when email is not configured', async () => {
    isEmailConfiguredMock.mockReturnValue(false);

    await requestPasswordReset('secret@b.com');

    expect(logSpies.warn).toHaveBeenCalledWith(
      '[password-reset] request.skipped reason=email-not-configured',
    );
  });

  it('logs a per-address rate-limit skip with the retry time', async () => {
    checkRateLimitMock.mockRejectedValue(new RateLimitedError(90_000));

    await requestPasswordReset('secret@b.com');

    expect(logSpies.warn).toHaveBeenCalledWith(
      '[password-reset] request.skipped reason=per-address-rate-limit retryAfterSec=90',
    );
  });

  it('logs an unknown address without the address', async () => {
    prismaMock.user.findMany.mockResolvedValue([]);

    await requestPasswordReset('secret@b.com');

    expect(logSpies.info).toHaveBeenCalledWith('[password-reset] request.no-account');
    expect(allLogs()).not.toContain('secret@b.com');
  });

  it('logs the Google-only branch and the notice send', async () => {
    prismaMock.user.findMany.mockResolvedValue([{ ...passwordUser, passwordHash: null }]);

    await requestPasswordReset('secret@b.com');

    expect(logSpies.info).toHaveBeenCalledWith(
      '[password-reset] request.google-only userId=user-1',
    );
    expect(logSpies.info).toHaveBeenCalledWith(
      '[password-reset] email.sent kind=google-notice userId=user-1 messageId=<msg-1@brevo>',
    );
  });

  it('logs the issued token by hash prefix and the send, never the raw token or address', async () => {
    prismaMock.user.findMany.mockResolvedValue([passwordUser]);

    await requestPasswordReset('secret@b.com');

    const { tokenHash } = prismaMock.passwordResetToken.upsert.mock.calls[0]![0].create;
    const rawToken = sendEmailMock.mock.calls[0]![0].text.match(/token=([a-f0-9]+)/)![1];
    const ref = tokenHash.slice(0, 12);
    expect(logSpies.info).toHaveBeenCalledWith(
      expect.stringMatching(
        new RegExp(
          `^\\[password-reset\\] token\\.issued userId=user-1 tokenRef=${ref} expiresAt=\\S+ appUrl=\\S+$`,
        ),
      ),
    );
    expect(logSpies.info).toHaveBeenCalledWith(
      `[password-reset] email.sent kind=reset userId=user-1 tokenRef=${ref} messageId=<msg-1@brevo>`,
    );
    expect(allLogs()).not.toContain(rawToken);
    expect(allLogs()).not.toContain(tokenHash);
    expect(allLogs()).not.toContain('secret@b.com');
  });

  it('logs a Brevo failure with its status but not the address', async () => {
    prismaMock.user.findMany.mockResolvedValue([passwordUser]);
    sendEmailMock.mockRejectedValue(new EmailSendError('brevo responded 401'));

    await expect(requestPasswordReset('secret@b.com')).rejects.toThrow(EmailSendError);

    expect(logSpies.error).toHaveBeenCalledWith(
      expect.stringMatching(
        /^\[password-reset\] email\.failed kind=reset userId=user-1 tokenRef=[a-f0-9]{12} error=EmailSendError reason=Failed to send email: brevo responded 401$/,
      ),
    );
    expect(allLogs()).not.toContain('secret@b.com');
  });

  it('logs token checks with their status', async () => {
    prismaMock.passwordResetToken.findUnique.mockResolvedValueOnce(null);
    await getPasswordResetTokenStatus('raw');
    expect(logSpies.warn).toHaveBeenCalledWith(
      `[password-reset] token.checked status=invalid tokenRef=${sha256('raw').slice(0, 12)}`,
    );

    prismaMock.passwordResetToken.findUnique.mockResolvedValueOnce({
      userId: 'user-1',
      expiresAt: new Date(Date.now() - 1000),
    });
    await getPasswordResetTokenStatus('raw');
    expect(logSpies.warn).toHaveBeenCalledWith(
      expect.stringContaining('token.checked status=expired userId=user-1'),
    );
  });

  it('logs rejected and completed resets', async () => {
    const input = { token: 'raw', newPassword: 'a-long-enough-password' };
    const ref = sha256('raw').slice(0, 12);

    prismaMock.passwordResetToken.findUnique.mockResolvedValueOnce(null);
    await expect(resetPassword(input)).rejects.toThrow(ServiceValidationError);
    expect(logSpies.warn).toHaveBeenCalledWith(
      `[password-reset] reset.rejected reason=invalid tokenRef=${ref}`,
    );

    prismaMock.passwordResetToken.findUnique.mockResolvedValueOnce({
      userId: 'user-1',
      expiresAt: new Date(Date.now() + HOUR_MS),
      user: { emailVerified: null },
    });
    await resetPassword(input);
    expect(logSpies.info).toHaveBeenCalledWith(
      `[password-reset] reset.completed userId=user-1 tokenRef=${ref} emailVerified=now`,
    );
    expect(allLogs()).not.toContain('a-long-enough-password');
  });
});
