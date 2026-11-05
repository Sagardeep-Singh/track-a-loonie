import bcrypt from 'bcryptjs';
import { prisma } from '@/lib/db/prisma';
import { Prisma } from '@prisma/client';
import type { SignUpInput } from '@/lib/validators/signup';

const BCRYPT_ROUNDS = 12;

/** Better Auth's provider id for the email/password sign-in row, whose
 * `accountId` is the user's own id. */
export const CREDENTIAL_PROVIDER_ID = 'credential';

const credentialKey = (userId: string): { providerId: string; accountId: string } => ({
  providerId: CREDENTIAL_PROVIDER_ID,
  accountId: userId,
});

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
    const id = await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({ data: { email: input.email, name: input.name } });
      await tx.authAccount.create({
        data: { userId: user.id, ...credentialKey(user.id), password: passwordHash },
      });
      return user.id;
    });
    return { id, created: true };
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

/** The bcrypt hash on the user's credential sign-in row, or null for a Google-only account. */
export const getPasswordHash = async (
  userId: string,
  client: Prisma.TransactionClient = prisma,
): Promise<string | null> => {
  const account = await client.authAccount.findUnique({
    where: { providerId_accountId: credentialKey(userId) },
    select: { password: true },
  });
  return account?.password ?? null;
};

export const userHasPassword = async (userId: string): Promise<boolean> =>
  (await getPasswordHash(userId)) !== null;

/**
 * Replaces the password and signs the user out everywhere, so a leaked old
 * password or a stolen session doesn't outlive the change. Only for users
 * who already have a credential row: setting a first password on a
 * Google-only account isn't supported.
 */
export const replacePasswordHash = async (
  tx: Prisma.TransactionClient,
  userId: string,
  passwordHash: string,
): Promise<void> => {
  await tx.authAccount.update({
    where: { providerId_accountId: credentialKey(userId) },
    data: { password: passwordHash },
  });
  await tx.session.deleteMany({ where: { userId } });
};
