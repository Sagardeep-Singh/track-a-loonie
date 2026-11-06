import bcrypt from 'bcryptjs';
import { prisma } from '@/lib/db/prisma';
import { ServiceValidationError } from '@/lib/services/common';
import { getPasswordHash, replacePasswordHash } from '@/lib/services/users';
import type { ChangePasswordInput } from '@/lib/validators/password';

const BCRYPT_ROUNDS = 12;

export const changePassword = async (
  userId: string,
  input: ChangePasswordInput,
): Promise<{ ok: true }> => {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
  if (!user) {
    throw new ServiceValidationError('Your session is no longer valid. Sign in again.');
  }
  const currentHash = await getPasswordHash(userId);
  if (!currentHash) {
    throw new ServiceValidationError(
      'This account signed up with Google and has no password to change.',
    );
  }

  const currentMatches = await bcrypt.compare(input.currentPassword, currentHash);
  if (!currentMatches) {
    throw new ServiceValidationError('Current password is incorrect.');
  }

  const sameAsCurrent = await bcrypt.compare(input.newPassword, currentHash);
  if (sameAsCurrent) {
    throw new ServiceValidationError('New password must be different from your current password.');
  }

  const passwordHash = await bcrypt.hash(input.newPassword, BCRYPT_ROUNDS);
  // Also signs out every session, this one included (the caller redirects
  // to /login), so other devices can't keep using the old credentials.
  await prisma.$transaction((tx) => replacePasswordHash(tx, userId, passwordHash));

  return { ok: true };
};
