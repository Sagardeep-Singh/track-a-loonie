import { beforeEach, describe, expect, it, vi } from 'vitest';
import bcrypt from 'bcryptjs';
import { Prisma } from '@prisma/client';

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    user: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    category: {
      createMany: vi.fn(),
      findMany: vi.fn(),
    },
    categoryRule: {
      createMany: vi.fn(),
    },
    account: {
      create: vi.fn(),
    },
    authAccount: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    session: {
      deleteMany: vi.fn(),
    },
    $transaction: vi.fn(),
  },
}));

vi.mock('@/lib/db/prisma', () => ({ prisma: prismaMock }));

const { createUser, getPasswordHash, replacePasswordHash, userHasPassword } =
  await import('@/lib/services/users');
const { DEFAULT_CATEGORIES } = await import('@/lib/services/defaults');

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.$transaction.mockImplementation((fn: (tx: typeof prismaMock) => unknown) =>
    fn(prismaMock),
  );
  prismaMock.category.findMany.mockResolvedValue(
    DEFAULT_CATEGORIES.map((name, i) => ({ id: `cat-${i}`, name })),
  );
});

describe('createUser', () => {
  const input = { name: 'Jane', email: 'jane@example.com', password: 'a-long-enough-password' };

  it('returns the existing id with created: false for a duplicate email, writing nothing', async () => {
    prismaMock.user.findUnique.mockResolvedValue({ id: 'existing' });

    await expect(createUser(input)).resolves.toEqual({ id: 'existing', created: false });
    expect(prismaMock.user.create).not.toHaveBeenCalled();
  });

  it('still hashes the password for a duplicate email so timing matches a real signup', async () => {
    prismaMock.user.findUnique.mockResolvedValue({ id: 'existing' });
    const hashSpy = vi.spyOn(bcrypt, 'hash');

    await createUser(input);

    expect(hashSpy).toHaveBeenCalledWith('a-long-enough-password', 12);
    hashSpy.mockRestore();
  });

  it('treats losing a concurrent create race (P2002) as an existing account', async () => {
    prismaMock.user.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'winner' });
    prismaMock.user.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: 'test',
      }),
    );

    await expect(createUser(input)).resolves.toEqual({ id: 'winner', created: false });
  });

  it('rethrows other create errors', async () => {
    prismaMock.user.findUnique.mockResolvedValue(null);
    prismaMock.user.create.mockRejectedValue(new Error('db down'));

    await expect(createUser(input)).rejects.toThrow('db down');
  });

  it('creates the user and a credential row with the bcrypt hash, and no prepopulated data', async () => {
    prismaMock.user.findUnique.mockResolvedValue(null);
    prismaMock.user.create.mockResolvedValue({ id: 'user-1' });

    const result = await createUser(input);

    expect(result).toEqual({ id: 'user-1', created: true });

    expect(prismaMock.user.create).toHaveBeenCalledWith({
      data: { email: 'jane@example.com', name: 'Jane' },
    });
    const [accountArg] = prismaMock.authAccount.create.mock.calls[0];
    expect(accountArg.data).toMatchObject({
      userId: 'user-1',
      providerId: 'credential',
      accountId: 'user-1',
    });
    await expect(bcrypt.compare('a-long-enough-password', accountArg.data.password)).resolves.toBe(
      true,
    );

    expect(prismaMock.category.createMany).not.toHaveBeenCalled();
    expect(prismaMock.categoryRule.createMany).not.toHaveBeenCalled();
    expect(prismaMock.account.create).not.toHaveBeenCalled();
  });
});

describe('getPasswordHash', () => {
  it('reads the credential row keyed by the user id', async () => {
    prismaMock.authAccount.findUnique.mockResolvedValue({ password: 'hashed' });

    await expect(getPasswordHash('user-1')).resolves.toBe('hashed');
    expect(prismaMock.authAccount.findUnique).toHaveBeenCalledWith({
      where: { providerId_accountId: { providerId: 'credential', accountId: 'user-1' } },
      select: { password: true },
    });
  });

  it('returns null when there is no credential row (Google-only account)', async () => {
    prismaMock.authAccount.findUnique.mockResolvedValue(null);

    await expect(getPasswordHash('user-1')).resolves.toBeNull();
  });
});

describe('replacePasswordHash', () => {
  it("updates the credential row and deletes every one of the user's sessions", async () => {
    await replacePasswordHash(prismaMock as never, 'user-1', 'new-hash');

    expect(prismaMock.authAccount.update).toHaveBeenCalledWith({
      where: { providerId_accountId: { providerId: 'credential', accountId: 'user-1' } },
      data: { password: 'new-hash' },
    });
    expect(prismaMock.session.deleteMany).toHaveBeenCalledWith({ where: { userId: 'user-1' } });
  });
});

describe('userHasPassword', () => {
  it('returns true when the user has a credential row with a password', async () => {
    prismaMock.authAccount.findUnique.mockResolvedValue({ password: 'hashed' });

    await expect(userHasPassword('user-1')).resolves.toBe(true);
  });

  it('returns false for a Google-only user with no credential row', async () => {
    prismaMock.authAccount.findUnique.mockResolvedValue(null);

    await expect(userHasPassword('user-1')).resolves.toBe(false);
  });
});
