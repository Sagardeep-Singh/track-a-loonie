import bcrypt from 'bcryptjs';
import { prisma } from '@/lib/db/prisma';
import { cancelSubscriptionForDeletion } from '@/lib/services/billing';
import { GoogleReauthRequiredError, ServiceValidationError } from '@/lib/services/common';
import { wipeUserData } from '@/lib/services/userData';
import type { DeleteAccountInput } from '@/lib/validators/account-deletion';

/** How recently a Google-only user must have completed an interactive
 * `prompt=login` round-trip for their `reauthenticatedAt` JWT claim to count
 * as proof they still control the account — the passwordless equivalent of
 * `currentPassword` re-entry. Long enough to cover the OAuth redirect plus
 * reading the confirm copy and typing the confirm email; short enough that
 * it isn't a standing bypass. */
const GOOGLE_REAUTH_WINDOW_MS = 5 * 60 * 1000;

export const deleteUserAccount = async (
  userId: string,
  input: DeleteAccountInput,
  googleReauthenticatedAt: number | null,
): Promise<{ ok: true }> => {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true, passwordHash: true },
  });
  if (!user) {
    throw new ServiceValidationError('Your session is no longer valid. Sign in again.');
  }

  if (input.confirmEmail.trim().toLowerCase() !== user.email.toLowerCase()) {
    throw new ServiceValidationError('The email you typed does not match your account email.');
  }

  if (user.passwordHash !== null) {
    if (
      !input.currentPassword ||
      !(await bcrypt.compare(input.currentPassword, user.passwordHash))
    ) {
      throw new ServiceValidationError('Password is incorrect.');
    }
  } else {
    const isFresh =
      googleReauthenticatedAt !== null &&
      Date.now() - googleReauthenticatedAt <= GOOGLE_REAUTH_WINDOW_MS;
    if (!isFresh) {
      throw new GoogleReauthRequiredError('Confirm your identity with Google again, then retry.');
    }
  }

  await cancelSubscriptionForDeletion(userId);

  await prisma.$transaction(
    async (tx) => {
      await wipeUserData(tx, userId);
      await tx.user.delete({ where: { id: userId } });
    },
    { timeout: 30_000, maxWait: 10_000 },
  );

  return { ok: true };
};
