import bcrypt from 'bcryptjs';
import { prisma } from '@/lib/db/prisma';
import { ServiceValidationError } from '@/lib/services/common';
import type { ChangePasswordInput } from '@/lib/validators/password';

const BCRYPT_ROUNDS = 12;

export const changePassword = async (
  userId: string,
  input: ChangePasswordInput,
): Promise<{ ok: true }> => {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { passwordHash: true },
  });
  if (!user) {
    throw new ServiceValidationError('Your session is no longer valid. Sign in again.');
  }
  if (!user.passwordHash) {
    throw new ServiceValidationError(
      'This account signed up with Google and has no password to change.',
    );
  }

  const currentMatches = await bcrypt.compare(input.currentPassword, user.passwordHash);
  if (!currentMatches) {
    throw new ServiceValidationError('Current password is incorrect.');
  }

  const sameAsCurrent = await bcrypt.compare(input.newPassword, user.passwordHash);
  if (sameAsCurrent) {
    throw new ServiceValidationError('New password must be different from your current password.');
  }

  const passwordHash = await bcrypt.hash(input.newPassword, BCRYPT_ROUNDS);
  // passwordChangedAt revokes every session issued before now (jwt callback)
  await prisma.user.update({
    where: { id: userId },
    data: { passwordHash, passwordChangedAt: new Date() },
  });

  return { ok: true };
};
