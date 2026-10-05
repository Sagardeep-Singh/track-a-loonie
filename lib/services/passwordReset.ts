import { randomBytes, createHash } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db/prisma';
import { isEmailConfigured, sendEmail } from '@/lib/email/brevo';
import { buildPasswordResetEmail } from '@/lib/email/password-reset-email';
import { buildPasswordResetGoogleEmail } from '@/lib/email/password-reset-google-email';
import { appBaseUrl } from '@/lib/http/appUrl';
import { ServiceValidationError } from '@/lib/services/common';
import { checkRateLimit, RateLimitedError } from '@/lib/services/rateLimit';
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
export const requestPasswordReset = async (email: string): Promise<void> => {
  if (!isPasswordResetConfigured()) {
    return;
  }

  try {
    await checkRateLimit(
      'password-reset:email',
      email.toLowerCase(),
      REQUEST_HOURLY_LIMIT,
      REQUEST_WINDOW_MS,
    );
  } catch (error) {
    if (error instanceof RateLimitedError) {
      console.warn('[password-reset] per-address limit hit, email skipped');
      return;
    }
    throw error;
  }

  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, email: true, passwordHash: true },
  });
  if (!user) {
    return;
  }

  if (!user.passwordHash) {
    await sendEmail({
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

  await sendEmail({
    to: user.email,
    ...buildPasswordResetEmail({
      appUrl: appBaseUrl(),
      resetUrl: resetUrl(rawToken),
      minutesValid: TOKEN_TTL_MS / (60 * 1000),
    }),
  });
};

export type PasswordResetTokenStatus = 'valid' | 'invalid' | 'expired';

/** Lets the reset page show an error up front instead of after the user types a password. */
export const getPasswordResetTokenStatus = async (
  rawToken: string,
): Promise<PasswordResetTokenStatus> => {
  const token = await prisma.passwordResetToken.findUnique({
    where: { tokenHash: hashToken(rawToken) },
    select: { expiresAt: true },
  });
  if (!token) {
    return 'invalid';
  }
  return token.expiresAt.getTime() < Date.now() ? 'expired' : 'valid';
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
  const token = await prisma.passwordResetToken.findUnique({
    where: { tokenHash: hashToken(input.token) },
    select: { userId: true, expiresAt: true, user: { select: { emailVerified: true } } },
  });
  if (!token) {
    throw new ServiceValidationError(INVALID_LINK_MESSAGE);
  }
  if (token.expiresAt.getTime() < Date.now()) {
    await prisma.passwordResetToken.delete({ where: { userId: token.userId } });
    throw new ServiceValidationError(EXPIRED_LINK_MESSAGE);
  }

  const passwordHash = await bcrypt.hash(input.newPassword, BCRYPT_ROUNDS);

  // Deleting by `tokenHash` (not `userId`) inside the transaction means two
  // concurrent submits of the same link can't both succeed: the loser's
  // delete finds no row and rolls its password update back.
  try {
    await prisma.$transaction([
      prisma.passwordResetToken.delete({ where: { tokenHash: hashToken(input.token) } }),
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
      throw new ServiceValidationError(INVALID_LINK_MESSAGE);
    }
    throw error;
  }

  return { ok: true };
};
