import { randomBytes, createHash } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db/prisma';
import {
  EmailSendError,
  EmailUnavailableError,
  isEmailConfigured,
  sendEmail,
} from '@/lib/email/brevo';
import { buildPasswordResetEmail } from '@/lib/email/password-reset-email';
import { buildPasswordResetGoogleEmail } from '@/lib/email/password-reset-google-email';
import { appBaseUrl } from '@/lib/http/appUrl';
import { ServiceValidationError } from '@/lib/services/common';
import { checkRateLimit, RateLimitedError } from '@/lib/services/rateLimit';
import { normalizeEmail } from '@/lib/validators/email';
import type { ResetPasswordInput } from '@/lib/validators/password';

const BCRYPT_ROUNDS = 12;
const TOKEN_BYTES = 32;
// Shorter than the 24h verification link: this one hands over the account.
const TOKEN_TTL_MS = 60 * 60 * 1000;
// The target is whatever address gets typed in, so cap sends per address
// (same reasoning as the signup "account exists" notice).
const REQUEST_HOURLY_LIMIT = 3;
const REQUEST_WINDOW_MS = 60 * 60 * 1000;

const INVALID_LINK_MESSAGE = 'This reset link is invalid or has already been used.';
const EXPIRED_LINK_MESSAGE = 'This reset link has expired. Request a new one.';

const isRecordNotFound = (error: unknown): boolean =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025';

const hashToken = (rawToken: string): string => createHash('sha256').update(rawToken).digest('hex');

/**
 * Short, non-reversible handle for a token in logs: the first 12 hex chars of
 * the stored `tokenHash`, so a log line can be matched to its DB row
 * (`WHERE "tokenHash" LIKE '<ref>%'`) without the raw token ever being logged.
 */
const tokenRef = (tokenHash: string): string => tokenHash.slice(0, 12);

type LogFields = Record<string, string | number | undefined>;

/**
 * One line per outcome, `[password-reset] <event> key=value ...`, so a
 * missing email can be traced through every branch. Never pass the email
 * address, the raw token or a raw error message (Prisma's can echo query
 * arguments): user ids, token refs, error names and codes only.
 */
const log = (level: 'info' | 'warn' | 'error', event: string, fields: LogFields = {}): void => {
  const details = Object.entries(fields)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${value}`)
    .join(' ');
  console[level](`[password-reset] ${event}${details ? ` ${details}` : ''}`);
};

/** Brevo's own errors carry only a status or "network", never the recipient, so their message is safe to log. */
const describeSendError = (error: unknown): LogFields => ({
  error: error instanceof Error ? error.name : 'unknown',
  reason:
    error instanceof EmailSendError || error instanceof EmailUnavailableError
      ? error.message
      : undefined,
});

const sendLogged = async (
  kind: 'reset' | 'google-notice',
  userId: string,
  params: Parameters<typeof sendEmail>[0],
  extra: LogFields = {},
): Promise<void> => {
  try {
    const { messageId } = await sendEmail(params);
    log('info', 'email.sent', { kind, userId, ...extra, messageId: messageId ?? 'none' });
  } catch (error) {
    log('error', 'email.failed', { kind, userId, ...extra, ...describeSendError(error) });
    throw error;
  }
};

const resetUrl = (rawToken: string): string => `${appBaseUrl()}/reset-password?token=${rawToken}`;

export const isPasswordResetConfigured = (): boolean => isEmailConfigured();

/**
 * Always resolves the same way for known, unknown and Google-only addresses
 * so the form can't be used to check whether an address is registered. The
 * difference only shows up in the inbox: a reset link, a "sign in with
 * Google" notice, or nothing.
 *
 * Over the per-address limit it skips silently, since there's nobody to
 * report it to. Send failures are thrown; the caller decides whether that's
 * fatal (it isn't for the form, an error on one path would leak which path
 * ran).
 */
export const requestPasswordReset = async (rawEmail: string): Promise<void> => {
  const email = normalizeEmail(rawEmail);

  if (!isPasswordResetConfigured()) {
    log('warn', 'request.skipped', { reason: 'email-not-configured' });
    return;
  }

  try {
    await checkRateLimit('password-reset:email', email, REQUEST_HOURLY_LIMIT, REQUEST_WINDOW_MS);
  } catch (error) {
    if (error instanceof RateLimitedError) {
      log('warn', 'request.skipped', {
        reason: 'per-address-rate-limit',
        retryAfterSec: Math.ceil(error.retryAfterMs / 1000),
      });
      return;
    }
    throw error;
  }

  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, email: true, passwordHash: true },
  });
  if (!user) {
    log('info', 'request.no-account');
    return;
  }

  if (!user.passwordHash) {
    log('info', 'request.google-only', { userId: user.id });
    await sendLogged('google-notice', user.id, {
      to: user.email,
      ...buildPasswordResetGoogleEmail({ appUrl: appBaseUrl(), loginUrl: `${appBaseUrl()}/login` }),
    });
    return;
  }

  const rawToken = randomBytes(TOKEN_BYTES).toString('hex');
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + TOKEN_TTL_MS);
  // Replaces any earlier row, so only the newest emailed link works.
  await prisma.passwordResetToken.upsert({
    where: { userId: user.id },
    create: { userId: user.id, tokenHash, expiresAt },
    update: { tokenHash, expiresAt, createdAt: new Date() },
  });
  const ref = tokenRef(tokenHash);
  log('info', 'token.issued', {
    userId: user.id,
    tokenRef: ref,
    expiresAt: expiresAt.toISOString(),
    appUrl: appBaseUrl(),
  });

  await sendLogged(
    'reset',
    user.id,
    {
      to: user.email,
      ...buildPasswordResetEmail({
        appUrl: appBaseUrl(),
        resetUrl: resetUrl(rawToken),
        minutesValid: TOKEN_TTL_MS / (60 * 1000),
      }),
    },
    { tokenRef: ref },
  );
};

export type PasswordResetTokenStatus = 'valid' | 'invalid' | 'expired';

/** Lets the reset page show an error up front instead of after the user types a password. */
export const getPasswordResetTokenStatus = async (
  rawToken: string,
): Promise<PasswordResetTokenStatus> => {
  const tokenHash = hashToken(rawToken);
  const token = await prisma.passwordResetToken.findUnique({
    where: { tokenHash },
    select: { userId: true, expiresAt: true },
  });
  if (!token) {
    log('warn', 'token.checked', { status: 'invalid', tokenRef: tokenRef(tokenHash) });
    return 'invalid';
  }
  const status = token.expiresAt.getTime() < Date.now() ? 'expired' : 'valid';
  log(status === 'valid' ? 'info' : 'warn', 'token.checked', {
    status,
    userId: token.userId,
    tokenRef: tokenRef(tokenHash),
    expiresAt: token.expiresAt.toISOString(),
  });
  return status;
};

/**
 * Public by design: the link is opened from an email client with no session.
 * A valid, unexpired token is the only credential, and it proves control of
 * the mailbox, so an unverified address gets marked verified too (same
 * reasoning as `consumeVerificationToken`).
 *
 * Other devices stay signed in: sessions are JWTs with no server-side store
 * to revoke, same caveat as `changePassword`.
 */
export const resetPassword = async (input: ResetPasswordInput): Promise<{ ok: true }> => {
  const tokenHash = hashToken(input.token);
  const ref = tokenRef(tokenHash);
  const token = await prisma.passwordResetToken.findUnique({
    where: { tokenHash },
    select: { userId: true, expiresAt: true, user: { select: { emailVerified: true } } },
  });
  if (!token) {
    log('warn', 'reset.rejected', { reason: 'invalid', tokenRef: ref });
    throw new ServiceValidationError(INVALID_LINK_MESSAGE);
  }
  if (token.expiresAt.getTime() < Date.now()) {
    await prisma.passwordResetToken.delete({ where: { userId: token.userId } });
    log('warn', 'reset.rejected', { reason: 'expired', userId: token.userId, tokenRef: ref });
    throw new ServiceValidationError(EXPIRED_LINK_MESSAGE);
  }

  const passwordHash = await bcrypt.hash(input.newPassword, BCRYPT_ROUNDS);

  // Deleting by `tokenHash` (not `userId`) inside the transaction means two
  // concurrent submits of the same link can't both succeed: the loser's
  // delete finds no row and rolls its password update back.
  try {
    await prisma.$transaction([
      prisma.passwordResetToken.delete({ where: { tokenHash } }),
      prisma.user.update({
        where: { id: token.userId },
        data: {
          passwordHash,
          ...(token.user.emailVerified ? {} : { emailVerified: new Date() }),
        },
      }),
    ]);
  } catch (error) {
    if (isRecordNotFound(error)) {
      log('warn', 'reset.rejected', {
        reason: 'used-concurrently',
        userId: token.userId,
        tokenRef: ref,
      });
      throw new ServiceValidationError(INVALID_LINK_MESSAGE);
    }
    throw error;
  }

  log('info', 'reset.completed', {
    userId: token.userId,
    tokenRef: ref,
    emailVerified: token.user.emailVerified ? 'already' : 'now',
  });
  return { ok: true };
};
