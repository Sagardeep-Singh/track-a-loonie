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
  },
}));

vi.mock('@/lib/db/prisma', () => ({ prisma: prismaMock }));

const { createUser, findOrCreateGoogleUser, userHasPassword } =
  await import('@/lib/services/users');
const { DEFAULT_CATEGORIES } = await import('@/lib/services/defaults');

beforeEach(() => {
  vi.clearAllMocks();
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

  it('hashes the password and creates the user with no prepopulated data', async () => {
    prismaMock.user.findUnique.mockResolvedValue(null);
    prismaMock.user.create.mockResolvedValue({ id: 'user-1' });

    const result = await createUser(input);

    expect(result).toEqual({ id: 'user-1', created: true });

    const [createArg] = prismaMock.user.create.mock.calls[0];
    expect(createArg.data.email).toBe('jane@example.com');
    expect(createArg.data.name).toBe('Jane');
    expect(createArg.data.passwordHash).not.toBe('a-long-enough-password');

    expect(prismaMock.category.createMany).not.toHaveBeenCalled();
    expect(prismaMock.categoryRule.createMany).not.toHaveBeenCalled();
    expect(prismaMock.account.create).not.toHaveBeenCalled();
  });
});

describe('findOrCreateGoogleUser', () => {
  it('returns an already-verified existing user without touching it', async () => {
    prismaMock.user.findUnique.mockResolvedValue({ id: 'user-1', emailVerified: new Date() });

    const result = await findOrCreateGoogleUser('jane@example.com', 'Jane');

    expect(result).toEqual({ id: 'user-1' });
    expect(prismaMock.user.create).not.toHaveBeenCalled();
    expect(prismaMock.user.update).not.toHaveBeenCalled();
    expect(prismaMock.account.create).not.toHaveBeenCalled();
  });

  it('looks up and creates by the normalized address', async () => {
    prismaMock.user.findUnique.mockResolvedValue(null);
    prismaMock.user.create.mockResolvedValue({ id: 'user-2' });

    await findOrCreateGoogleUser(' Jane@Example.COM ', 'Jane');

    expect(prismaMock.user.findUnique).toHaveBeenCalledWith({
      where: { email: 'jane@example.com' },
    });
    expect(prismaMock.user.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ email: 'jane@example.com' }),
    });
  });

  it('marks an existing unverified user verified — a live Google sign-in vouches for the address', async () => {
    prismaMock.user.findUnique.mockResolvedValue({ id: 'user-1', emailVerified: null });

    const result = await findOrCreateGoogleUser('jane@example.com', 'Jane');

    expect(result).toEqual({ id: 'user-1' });
    expect(prismaMock.user.update).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      data: { emailVerified: expect.any(Date) },
    });
    expect(prismaMock.user.create).not.toHaveBeenCalled();
  });

  it('creates a verified, password-less user on first sign-in with no prepopulated data', async () => {
    prismaMock.user.findUnique.mockResolvedValue(null);
    prismaMock.user.create.mockResolvedValue({ id: 'user-2' });

    const result = await findOrCreateGoogleUser('new@example.com', 'New Person');

    expect(result).toEqual({ id: 'user-2' });
    expect(prismaMock.user.create).toHaveBeenCalledWith({
      data: { email: 'new@example.com', name: 'New Person', emailVerified: expect.any(Date) },
    });
    expect(prismaMock.category.createMany).not.toHaveBeenCalled();
    expect(prismaMock.categoryRule.createMany).not.toHaveBeenCalled();
    expect(prismaMock.account.create).not.toHaveBeenCalled();
  });
});

describe('userHasPassword', () => {
  it('returns true when the user has a passwordHash', async () => {
    prismaMock.user.findUnique.mockResolvedValue({ passwordHash: 'hashed' });

    await expect(userHasPassword('user-1')).resolves.toBe(true);
  });

  it('returns false for a Google-only user with no passwordHash', async () => {
    prismaMock.user.findUnique.mockResolvedValue({ passwordHash: null });

    await expect(userHasPassword('user-1')).resolves.toBe(false);
  });

  it('returns false when the user does not exist', async () => {
    prismaMock.user.findUnique.mockResolvedValue(null);

    await expect(userHasPassword('missing')).resolves.toBe(false);
  });
});
