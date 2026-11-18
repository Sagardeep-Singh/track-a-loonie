import { beforeEach, describe, expect, it, vi } from 'vitest';

const { prismaMock, sendEmailMock, isEmailConfiguredMock, checkRateLimitMock } = vi.hoisted(() => ({
  prismaMock: {
    emailVerificationToken: {
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
}));

vi.mock('@/lib/db/prisma', () => ({ prisma: prismaMock }));
vi.mock('@/lib/services/rateLimit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/services/rateLimit')>()),
  checkRateLimit: checkRateLimitMock,
}));
vi.mock('@/lib/email/brevo', () => ({
  sendEmail: sendEmailMock,
  isEmailConfigured: isEmailConfiguredMock,
}));

const {
  issueAndSendVerificationEmail,
  sendAccountExistsEmail,
  resendVerificationEmail,
  consumeVerificationToken,
  getEmailVerificationStatus,
} = await import('@/lib/services/emailVerification');
const { RateLimitedError } = await import('@/lib/services/rateLimit');

beforeEach(() => {
  vi.clearAllMocks();
  isEmailConfiguredMock.mockReturnValue(true);
  prismaMock.$transaction.mockImplementation(async (ops: Promise<unknown>[]) => Promise.all(ops));
});

describe('issueAndSendVerificationEmail', () => {
  it('does nothing when email is not configured', async () => {
    isEmailConfiguredMock.mockReturnValue(false);

    await issueAndSendVerificationEmail('user-1', 'a@b.com');

    expect(prismaMock.emailVerificationToken.upsert).not.toHaveBeenCalled();
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('upserts a token keyed by userId and sends the email', async () => {
    prismaMock.emailVerificationToken.upsert.mockResolvedValue({});
    sendEmailMock.mockResolvedValue(undefined);

    await issueAndSendVerificationEmail('user-1', 'a@b.com');

    expect(prismaMock.emailVerificationToken.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 'user-1' } }),
    );
    expect(sendEmailMock).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'a@b.com', subject: expect.stringContaining('Verify') }),
    );
  });

  it('propagates a send failure to the caller', async () => {
    prismaMock.emailVerificationToken.upsert.mockResolvedValue({});
    sendEmailMock.mockRejectedValue(new Error('brevo down'));

    await expect(issueAndSendVerificationEmail('user-1', 'a@b.com')).rejects.toThrow('brevo down');
  });
});

describe('sendAccountExistsEmail', () => {
  it('does nothing when email is not configured', async () => {
    isEmailConfiguredMock.mockReturnValue(false);

    await sendAccountExistsEmail('a@b.com');

    expect(checkRateLimitMock).not.toHaveBeenCalled();
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('rate limits per lowercased address, then sends the notice with a login link', async () => {
    checkRateLimitMock.mockResolvedValue(undefined);
    sendEmailMock.mockResolvedValue(undefined);

    await sendAccountExistsEmail('Jane@Example.com');

    expect(checkRateLimitMock).toHaveBeenCalledWith(
      'signup-exists:email',
      'jane@example.com',
      3,
      60 * 60 * 1000,
    );
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    const [arg] = sendEmailMock.mock.calls[0];
    expect(arg.to).toBe('Jane@Example.com');
    expect(arg.subject).toBe('You already have a Track a Loonie account');
    expect(arg.text).toMatch(/Sign in: https?:\/\/[^\s]+\/login/);
    expect(prismaMock.emailVerificationToken.upsert).not.toHaveBeenCalled();
  });

  it('skips silently when the address is over its hourly limit', async () => {
    checkRateLimitMock.mockRejectedValue(new RateLimitedError(60_000));

    await expect(sendAccountExistsEmail('a@b.com')).resolves.toBeUndefined();
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('propagates send failures so the caller decides', async () => {
    checkRateLimitMock.mockResolvedValue(undefined);
    sendEmailMock.mockRejectedValue(new Error('brevo down'));

    await expect(sendAccountExistsEmail('a@b.com')).rejects.toThrow('brevo down');
  });
});

describe('resendVerificationEmail', () => {
  it('sends immediately when there is no prior token', async () => {
    prismaMock.emailVerificationToken.findUnique.mockResolvedValue(null);
    prismaMock.emailVerificationToken.upsert.mockResolvedValue({});
    sendEmailMock.mockResolvedValue(undefined);

    const result = await resendVerificationEmail('user-1', 'a@b.com');

    expect(result).toEqual({ ok: true });
    expect(sendEmailMock).toHaveBeenCalled();
  });

  it('rejects with retryAfterMs inside the cooldown window', async () => {
    prismaMock.emailVerificationToken.findUnique.mockResolvedValue({
      createdAt: new Date(Date.now() - 5_000),
    });

    const result = await resendVerificationEmail('user-1', 'a@b.com');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.retryAfterMs).toBeGreaterThan(0);
      expect(result.retryAfterMs).toBeLessThanOrEqual(60_000);
    }
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('sends again once the cooldown has elapsed', async () => {
    prismaMock.emailVerificationToken.findUnique.mockResolvedValue({
      createdAt: new Date(Date.now() - 120_000),
    });
    prismaMock.emailVerificationToken.upsert.mockResolvedValue({});
    sendEmailMock.mockResolvedValue(undefined);

    const result = await resendVerificationEmail('user-1', 'a@b.com');

    expect(result).toEqual({ ok: true });
    expect(sendEmailMock).toHaveBeenCalled();
  });

  it('counts each send against a per-user limit of 5 an hour', async () => {
    prismaMock.emailVerificationToken.findUnique.mockResolvedValue(null);
    prismaMock.emailVerificationToken.upsert.mockResolvedValue({});
    sendEmailMock.mockResolvedValue(undefined);

    await resendVerificationEmail('user-1', 'a@b.com');

    expect(checkRateLimitMock).toHaveBeenCalledWith(
      'verify-resend:user',
      'user-1',
      5,
      60 * 60 * 1000,
    );
  });

  it("rejects with the limiter's retryAfterMs once the hourly limit is hit, without sending", async () => {
    prismaMock.emailVerificationToken.findUnique.mockResolvedValue({
      createdAt: new Date(Date.now() - 120_000),
    });
    checkRateLimitMock.mockRejectedValueOnce(new RateLimitedError(1_800_000));

    const result = await resendVerificationEmail('user-1', 'a@b.com');

    expect(result).toEqual({ ok: false, retryAfterMs: 1_800_000 });
    expect(prismaMock.emailVerificationToken.upsert).not.toHaveBeenCalled();
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('does not use up the hourly limit on a click inside the cooldown', async () => {
    prismaMock.emailVerificationToken.findUnique.mockResolvedValue({
      createdAt: new Date(Date.now() - 5_000),
    });

    await resendVerificationEmail('user-1', 'a@b.com');

    expect(checkRateLimitMock).not.toHaveBeenCalled();
  });

  it('rethrows limiter failures that are not a rate-limit hit', async () => {
    prismaMock.emailVerificationToken.findUnique.mockResolvedValue(null);
    checkRateLimitMock.mockRejectedValueOnce(new Error('db down'));

    await expect(resendVerificationEmail('user-1', 'a@b.com')).rejects.toThrow('db down');
    expect(sendEmailMock).not.toHaveBeenCalled();
  });
});

describe('consumeVerificationToken', () => {
  it('returns invalid for an unknown token', async () => {
    prismaMock.emailVerificationToken.findUnique.mockResolvedValue(null);

    await expect(consumeVerificationToken('nope')).resolves.toBe('invalid');
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  it('returns expired for a token past its expiresAt, without consuming it', async () => {
    prismaMock.emailVerificationToken.findUnique.mockResolvedValue({
      userId: 'user-1',
      expiresAt: new Date(Date.now() - 1000),
    });

    await expect(consumeVerificationToken('stale')).resolves.toBe('expired');
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  it('marks the user verified and deletes the token on success', async () => {
    prismaMock.emailVerificationToken.findUnique.mockResolvedValue({
      userId: 'user-1',
      expiresAt: new Date(Date.now() + 1000),
    });
    prismaMock.user.update.mockResolvedValue({});
    prismaMock.emailVerificationToken.delete.mockResolvedValue({});

    await expect(consumeVerificationToken('good')).resolves.toBe('verified');
    expect(prismaMock.user.update).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      data: { emailVerified: true },
    });
    expect(prismaMock.emailVerificationToken.delete).toHaveBeenCalledWith({
      where: { userId: 'user-1' },
    });
  });
});

describe('getEmailVerificationStatus', () => {
  it('reports verified true when emailVerified is true', async () => {
    prismaMock.user.findUnique.mockResolvedValue({ emailVerified: true });

    await expect(getEmailVerificationStatus('user-1')).resolves.toEqual({
      verified: true,
      configured: true,
    });
  });

  it('reports verified false when emailVerified is false', async () => {
    prismaMock.user.findUnique.mockResolvedValue({ emailVerified: false });

    await expect(getEmailVerificationStatus('user-1')).resolves.toEqual({
      verified: false,
      configured: true,
    });
  });
});
