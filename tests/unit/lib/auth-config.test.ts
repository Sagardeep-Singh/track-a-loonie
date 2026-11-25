import { beforeEach, describe, expect, it, vi } from 'vitest';

const { prismaMock, findOrCreateGoogleUserMock } = vi.hoisted(() => ({
  prismaMock: { user: { findUnique: vi.fn() } },
  findOrCreateGoogleUserMock: vi.fn(),
}));

vi.mock('@/lib/db/prisma', () => ({ prisma: prismaMock }));
vi.mock('@/lib/services/users', () => ({ findOrCreateGoogleUser: findOrCreateGoogleUserMock }));

const { authConfig } = await import('@/lib/auth/config');

beforeEach(() => {
  vi.clearAllMocks();
});

const jwt = authConfig.callbacks!.jwt!;
const session = authConfig.callbacks!.session!;

describe('jwt callback', () => {
  it('sets reauthenticatedAt on a fresh Google sign-in', async () => {
    findOrCreateGoogleUserMock.mockResolvedValue({ id: 'user-1' });
    const before = Date.now();

    const token = await jwt({
      token: {},
      user: { email: 'a@example.com', name: 'A' },
      account: { provider: 'google' },
    } as never);

    expect(token).not.toBeNull();
    expect((token as { userId: string }).userId).toBe('user-1');
    expect((token as { reauthenticatedAt: number }).reauthenticatedAt).toBeGreaterThanOrEqual(
      before,
    );
    // A fresh sign-in already loaded the user via findOrCreateGoogleUser —
    // the stale-user existence check must not fire a redundant lookup.
    expect(prismaMock.user.findUnique).not.toHaveBeenCalled();
  });

  it('does not set reauthenticatedAt for a credentials sign-in', async () => {
    const token = await jwt({
      token: {},
      user: { id: 'user-2', email: 'b@example.com', name: 'B' },
      account: { provider: 'credentials' },
    } as never);

    expect((token as { userId: string }).userId).toBe('user-2');
    expect((token as { reauthenticatedAt?: number }).reauthenticatedAt).toBeUndefined();
    expect(prismaMock.user.findUnique).not.toHaveBeenCalled();
  });

  it('leaves an existing reauthenticatedAt untouched on a subsequent, non-sign-in call', async () => {
    prismaMock.user.findUnique.mockResolvedValue({ id: 'user-1' });

    const token = await jwt({
      token: { userId: 'user-1', reauthenticatedAt: 12345 },
      user: undefined,
      account: null,
    } as never);

    expect((token as { reauthenticatedAt: number }).reauthenticatedAt).toBe(12345);
    // No `user` on this call: it's a token refresh, not a sign-in, so the
    // stale-existence check is the one that must run.
    expect(prismaMock.user.findUnique).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      select: { id: true, passwordChangedAt: true },
    });
  });

  it('returns null for a token whose user no longer exists', async () => {
    prismaMock.user.findUnique.mockResolvedValue(null);

    const token = await jwt({
      token: { userId: 'deleted-user' },
      user: undefined,
      account: null,
    } as never);

    expect(token).toBeNull();
  });
});

describe('jwt callback password-change revocation', () => {
  const CHANGED_AT = new Date('2026-11-20T12:00:00.000Z');
  const refresh = (token: Record<string, unknown>): ReturnType<typeof jwt> =>
    jwt({ token: { userId: 'user-1', ...token }, user: undefined, account: null } as never);

  it('stamps authTime on sign-in', async () => {
    const before = Date.now();
    const token = await jwt({
      token: {},
      user: { id: 'user-1', email: 'a@example.com', name: 'A' },
      account: { provider: 'credentials' },
    } as never);

    expect((token as { authTime: number }).authTime).toBeGreaterThanOrEqual(before);
  });

  it('rejects a token established before the password changed', async () => {
    prismaMock.user.findUnique.mockResolvedValue({ id: 'user-1', passwordChangedAt: CHANGED_AT });

    await expect(refresh({ authTime: CHANGED_AT.getTime() - 1 })).resolves.toBeNull();
  });

  it('keeps a token established after the password changed', async () => {
    prismaMock.user.findUnique.mockResolvedValue({ id: 'user-1', passwordChangedAt: CHANGED_AT });

    const token = await refresh({ authTime: CHANGED_AT.getTime() + 1 });

    expect(token).not.toBeNull();
  });

  it('judges a legacy token without authTime by its iat', async () => {
    prismaMock.user.findUnique.mockResolvedValue({ id: 'user-1', passwordChangedAt: CHANGED_AT });
    const iatSeconds = (ms: number): number => Math.floor(ms / 1000);

    await expect(refresh({ iat: iatSeconds(CHANGED_AT.getTime()) - 60 })).resolves.toBeNull();
    await expect(refresh({ iat: iatSeconds(CHANGED_AT.getTime()) + 60 })).resolves.not.toBeNull();
  });

  it('keeps every token when the password has never changed', async () => {
    prismaMock.user.findUnique.mockResolvedValue({ id: 'user-1', passwordChangedAt: null });

    await expect(refresh({})).resolves.not.toBeNull();
  });
});

describe('session callback', () => {
  it('exposes reauthenticatedAt from the token', async () => {
    const result = (await session({
      session: { user: { id: '', email: null, name: null }, expires: '' },
      token: { userId: 'user-1', reauthenticatedAt: 999 },
    } as never)) as { user: { reauthenticatedAt: number | null } };

    expect(result.user.reauthenticatedAt).toBe(999);
  });

  it('exposes null when the token has no reauthenticatedAt (credentials session)', async () => {
    const result = (await session({
      session: { user: { id: '', email: null, name: null }, expires: '' },
      token: { userId: 'user-2' },
    } as never)) as { user: { reauthenticatedAt: number | null } };

    expect(result.user.reauthenticatedAt).toBeNull();
  });
});
