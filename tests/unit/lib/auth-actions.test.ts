import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  signInEmailMock,
  signInSocialMock,
  headersMock,
  redirectMock,
  createUserMock,
  checkRateLimitMock,
  issueAndSendVerificationEmailMock,
  sendAccountExistsEmailMock,
  isEmailVerificationConfiguredMock,
  requestPasswordResetMock,
  resetPasswordMock,
} = vi.hoisted(() => ({
  signInEmailMock: vi.fn(),
  signInSocialMock: vi.fn(),
  headersMock: vi.fn(),
  redirectMock: vi.fn(),
  createUserMock: vi.fn(),
  checkRateLimitMock: vi.fn(),
  issueAndSendVerificationEmailMock: vi.fn(),
  sendAccountExistsEmailMock: vi.fn(),
  isEmailVerificationConfiguredMock: vi.fn(),
  requestPasswordResetMock: vi.fn(),
  resetPasswordMock: vi.fn(),
}));

vi.mock('@/lib/auth/auth', () => ({
  auth: { api: { signInEmail: signInEmailMock, signInSocial: signInSocialMock, signOut: vi.fn() } },
}));
vi.mock('next/headers', () => ({ headers: headersMock }));
vi.mock('next/navigation', () => ({ redirect: redirectMock }));
vi.mock('@/lib/services/emailVerification', () => ({
  issueAndSendVerificationEmail: issueAndSendVerificationEmailMock,
  sendAccountExistsEmail: sendAccountExistsEmailMock,
  isEmailVerificationConfigured: isEmailVerificationConfiguredMock,
}));
vi.mock('@/lib/services/passwordReset', () => ({
  requestPasswordReset: requestPasswordResetMock,
  resetPassword: resetPasswordMock,
}));
vi.mock('@/lib/services/users', () => ({ createUser: createUserMock }));
vi.mock('@/lib/services/rateLimit', async () => {
  const actual = await vi.importActual<typeof import('@/lib/services/rateLimit')>(
    '@/lib/services/rateLimit',
  );
  return { ...actual, checkRateLimit: checkRateLimitMock };
});

const {
  signInAction,
  signInWithGoogleAction,
  reauthenticateWithGoogleAction,
  signUpAction,
  requestPasswordResetAction,
  resetPasswordAction,
} = await import('@/lib/auth/actions');
const { APIError } = await import('better-auth/api');
const { RateLimitedError } = await import('@/lib/services/rateLimit');
const { ServiceValidationError } = await import('@/lib/services/common');

const formData = (fields: Record<string, string>): FormData => {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    data.set(key, value);
  }
  return data;
};

beforeEach(() => {
  vi.clearAllMocks();
  headersMock.mockResolvedValue(new Headers({ 'x-forwarded-for': '1.2.3.4' }));
  // The real redirect() throws NEXT_REDIRECT; mirror that so nothing after it runs.
  redirectMock.mockImplementation((url: string) => {
    throw new RedirectSignal(url);
  });
  isEmailVerificationConfiguredMock.mockReturnValue(true);
  checkRateLimitMock.mockResolvedValue(undefined);
});

class RedirectSignal extends Error {
  constructor(public readonly url: string) {
    super(`redirect ${url}`);
  }
}

type FormAction = (prev: string | undefined, data: FormData) => Promise<string | undefined>;

const submitTo = async (action: FormAction, fields: Record<string, string>): Promise<string> => {
  try {
    const result = await action(undefined, formData(fields));
    throw new Error(`expected a redirect, got ${String(result)}`);
  } catch (error) {
    if (error instanceof RedirectSignal) return error.url;
    throw error;
  }
};

const submit = (fields: Record<string, string>): Promise<string> => submitTo(signUpAction, fields);

const redirectTarget = async (action: () => Promise<void>): Promise<string> => {
  try {
    await action();
    throw new Error('expected a redirect');
  } catch (error) {
    if (error instanceof RedirectSignal) return error.url;
    throw error;
  }
};

describe('signInAction', () => {
  const fields = { email: ' A@Example.com ', password: 'password123456' };

  it('rate limits by IP and normalized email before checking the password', async () => {
    await submitTo(signInAction, fields);

    expect(checkRateLimitMock).toHaveBeenCalledWith('login:ip', '1.2.3.4', 30, 15 * 60 * 1000);
    expect(checkRateLimitMock).toHaveBeenCalledWith(
      'login:email',
      'a@example.com',
      10,
      15 * 60 * 1000,
    );
    const lastRateLimitCall = checkRateLimitMock.mock.invocationCallOrder[1];
    expect(lastRateLimitCall).toBeLessThan(signInEmailMock.mock.invocationCallOrder[0]);
  });

  it('signs in with the normalized email and redirects to the dashboard', async () => {
    await expect(submitTo(signInAction, fields)).resolves.toBe('/dashboard');

    expect(signInEmailMock).toHaveBeenCalledWith({
      body: { email: 'a@example.com', password: 'password123456' },
      headers: expect.any(Headers),
    });
  });

  it('returns the generic message when Better Auth rejects the credentials', async () => {
    signInEmailMock.mockRejectedValue(
      new APIError('UNAUTHORIZED', { message: 'Invalid email or password' }),
    );

    await expect(signInAction(undefined, formData(fields))).resolves.toBe(
      'Incorrect email or password.',
    );
    expect(redirectMock).not.toHaveBeenCalled();
  });

  it('returns the rate-limit message without checking the password', async () => {
    checkRateLimitMock.mockRejectedValue(new RateLimitedError(60_000));

    await expect(signInAction(undefined, formData(fields))).resolves.toBe(
      'Too many attempts. Try again in a few minutes.',
    );
    expect(signInEmailMock).not.toHaveBeenCalled();
  });

  it('rethrows unexpected errors instead of hiding them behind the generic message', async () => {
    signInEmailMock.mockRejectedValue(new Error('db down'));

    await expect(signInAction(undefined, formData(fields))).rejects.toThrow('db down');
  });
});

describe('Google sign-in actions', () => {
  const googleUrl =
    'https://accounts.google.com/o/oauth2/v2/auth?client_id=x&prompt=select_account';

  it('redirects to the Google URL Better Auth returns, landing on the dashboard', async () => {
    signInSocialMock.mockResolvedValue({ url: googleUrl, redirect: true });

    await expect(redirectTarget(signInWithGoogleAction)).resolves.toBe(googleUrl);
    expect(signInSocialMock).toHaveBeenCalledWith({
      body: { provider: 'google', callbackURL: '/dashboard', errorCallbackURL: '/login' },
      headers: expect.any(Headers),
    });
  });

  it('forces prompt=login for the re-auth before account deletion', async () => {
    signInSocialMock.mockResolvedValue({ url: googleUrl, redirect: true });

    const target = new URL(await redirectTarget(reauthenticateWithGoogleAction));

    expect(target.searchParams.get('prompt')).toBe('login');
    expect(target.searchParams.get('client_id')).toBe('x');
    expect(signInSocialMock).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.objectContaining({ callbackURL: '/settings' }) }),
    );
  });
});

describe('signUpAction', () => {
  const validFields = { name: 'A User', email: 'a@example.com', password: 'password123456' };

  it('checks the signup:ip rate limit before creating the user', async () => {
    createUserMock.mockResolvedValue({ id: 'user-1', created: true });

    await submit(validFields);

    expect(checkRateLimitMock).toHaveBeenCalledWith('signup:ip', '1.2.3.4', 5, 60 * 60 * 1000);
    const rateLimitCallOrder = checkRateLimitMock.mock.invocationCallOrder[0];
    const createUserCallOrder = createUserMock.mock.invocationCallOrder[0];
    expect(rateLimitCallOrder).toBeLessThan(createUserCallOrder);
  });

  it('returns a friendly message and never creates a user when the IP is rate limited', async () => {
    checkRateLimitMock.mockRejectedValue(new RateLimitedError(60_000));

    const result = await signUpAction(undefined, formData(validFields));

    expect(result).toBe('Too many attempts. Try again in a few minutes.');
    expect(createUserMock).not.toHaveBeenCalled();
  });

  it('sends a verification email for a new account and redirects to the neutral login banner', async () => {
    createUserMock.mockResolvedValue({ id: 'user-1', created: true });

    const url = await submit(validFields);

    expect(url).toBe('/login?signup=check-email');
    expect(issueAndSendVerificationEmailMock).toHaveBeenCalledWith('user-1', 'a@example.com');
    expect(sendAccountExistsEmailMock).not.toHaveBeenCalled();
    expect(signInEmailMock).not.toHaveBeenCalled();
  });

  it('sends an account-exists notice for a taken email and gives the exact same response', async () => {
    createUserMock.mockResolvedValue({ id: 'existing', created: false });

    const url = await submit(validFields);

    expect(url).toBe('/login?signup=check-email');
    expect(sendAccountExistsEmailMock).toHaveBeenCalledWith('a@example.com');
    expect(issueAndSendVerificationEmailMock).not.toHaveBeenCalled();
    expect(signInEmailMock).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    'still redirects the same way when the email send fails (created: %s)',
    async (created) => {
      createUserMock.mockResolvedValue({ id: 'u', created });
      issueAndSendVerificationEmailMock.mockRejectedValue(new Error('brevo down'));
      sendAccountExistsEmailMock.mockRejectedValue(new Error('brevo down'));

      expect(await submit(validFields)).toBe('/login?signup=check-email');
    },
  );

  it.each([true, false])(
    'uses the no-email banner when email is not configured (created: %s)',
    async (created) => {
      isEmailVerificationConfiguredMock.mockReturnValue(false);
      createUserMock.mockResolvedValue({ id: 'u', created });

      expect(await submit(validFields)).toBe('/login?signup=done');
    },
  );
});

describe('requestPasswordResetAction', () => {
  it('rejects a malformed email without calling the service', async () => {
    const result = await requestPasswordResetAction(undefined, formData({ email: 'nope' }));

    expect(result).toBe('Enter a valid email address.');
    expect(requestPasswordResetMock).not.toHaveBeenCalled();
  });

  it('checks the password-reset:ip limit, then requests the reset and redirects', async () => {
    const url = await submitTo(requestPasswordResetAction, { email: ' a@example.com ' });

    expect(checkRateLimitMock).toHaveBeenCalledWith(
      'password-reset:ip',
      '1.2.3.4',
      10,
      60 * 60 * 1000,
    );
    expect(requestPasswordResetMock).toHaveBeenCalledWith('a@example.com');
    expect(url).toBe('/forgot-password?sent=1');
  });

  it('returns a friendly message and never sends when the IP is rate limited', async () => {
    checkRateLimitMock.mockRejectedValue(new RateLimitedError(60_000));

    const result = await requestPasswordResetAction(
      undefined,
      formData({ email: 'a@example.com' }),
    );

    expect(result).toBe('Too many attempts. Try again in a few minutes.');
    expect(requestPasswordResetMock).not.toHaveBeenCalled();
  });

  it('gives the same redirect when the send fails, and logs it without the address', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failure = Object.assign(new Error('table for a@example.com missing'), {
      name: 'PrismaClientKnownRequestError',
      code: 'P2021',
    });
    requestPasswordResetMock.mockRejectedValue(failure);

    expect(await submitTo(requestPasswordResetAction, { email: 'a@example.com' })).toBe(
      '/forgot-password?sent=1',
    );
    expect(errorSpy).toHaveBeenCalledWith(
      '[password-reset] request failed: PrismaClientKnownRequestError P2021',
    );
    expect(errorSpy.mock.calls.flat().join(' ')).not.toContain('a@example.com');
    errorSpy.mockRestore();
  });
});

describe('resetPasswordAction', () => {
  const validFields = {
    token: 'raw-token',
    newPassword: 'a-long-enough-password',
    confirmNewPassword: 'a-long-enough-password',
  };

  it('rejects a mismatched confirmation without calling the service', async () => {
    const result = await resetPasswordAction(
      undefined,
      formData({ ...validFields, confirmNewPassword: 'something-else-entirely' }),
    );

    expect(result).toBe('New password and confirmation do not match.');
    expect(resetPasswordMock).not.toHaveBeenCalled();
  });

  it('rejects a short password without calling the service', async () => {
    const result = await resetPasswordAction(
      undefined,
      formData({ ...validFields, newPassword: 'short', confirmNewPassword: 'short' }),
    );

    expect(result).toMatch(/at least/);
    expect(resetPasswordMock).not.toHaveBeenCalled();
  });

  it('resets the password and redirects to the login banner', async () => {
    resetPasswordMock.mockResolvedValue({ ok: true });

    const url = await submitTo(resetPasswordAction, validFields);

    expect(resetPasswordMock).toHaveBeenCalledWith({
      token: 'raw-token',
      newPassword: 'a-long-enough-password',
    });
    expect(url).toBe('/login?passwordReset=1');
  });

  it('surfaces a service validation error as the form message', async () => {
    resetPasswordMock.mockRejectedValue(new ServiceValidationError('This reset link has expired.'));

    const result = await resetPasswordAction(undefined, formData(validFields));

    expect(result).toBe('This reset link has expired.');
  });
});
