import bcrypt from 'bcryptjs';
import { prisma } from '@/lib/db/prisma';
import { Prisma } from '@prisma/client';
import type { SignUpInput } from '@/lib/validators/signup';
import { normalizeEmail } from '@/lib/validators/email';

const BCRYPT_ROUNDS = 12;

export type CreateUserResult = { id: string; created: boolean };

const isUniqueViolation = (error: unknown): boolean =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';

/**
 * Doesn't throw on a taken email: the caller has to answer both cases the
 * same way so signup can't be used to check whether an address is
 * registered. `created: false` means the address already had an account and
 * nothing was written.
 *
 * The password is hashed on both paths so the duplicate case isn't
 * noticeably faster than a real signup.
 */
export const createUser = async (input: SignUpInput): Promise<CreateUserResult> => {
  const passwordHash = await bcrypt.hash(input.password, BCRYPT_ROUNDS);

  const existing = await prisma.user.findUnique({
    where: { email: input.email },
    select: { id: true },
  });
  if (existing) {
    return { id: existing.id, created: false };
  }

  try {
    const user = await prisma.user.create({
      data: { email: input.email, name: input.name, passwordHash },
    });
    return { id: user.id, created: true };
  } catch (error) {
    // A concurrent signup for the same address won the race.
    if (isUniqueViolation(error)) {
      const winner = await prisma.user.findUnique({
        where: { email: input.email },
        select: { id: true },
      });
      if (winner) {
        return { id: winner.id, created: false };
      }
    }
    throw error;
  }
};

export const userHasPassword = async (userId: string): Promise<boolean> => {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { passwordHash: true },
  });
  return !!user?.passwordHash;
};

/**
 * Finds the user for a Google sign-in by email, provisioning a new
 * password-less account on first sign-in.
 */
export const findOrCreateGoogleUser = async (
  rawEmail: string,
  name: string | null,
): Promise<{ id: string }> => {
  const email = normalizeEmail(rawEmail);
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    // A live Google sign-in vouches for the address just as well as our own
    // emailed link — if the account got here via credentials signup and
    // never clicked its link, this Google sign-in satisfies it too.
    if (!existing.emailVerified) {
      await prisma.user.update({ where: { id: existing.id }, data: { emailVerified: new Date() } });
    }
    return { id: existing.id };
  }

  const user = await prisma.user.create({ data: { email, name, emailVerified: new Date() } });
  return { id: user.id };
};
