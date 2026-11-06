import { cookies, headers } from 'next/headers';
import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth/auth';

export type AppSession = {
  user: {
    id: string;
    email: string;
    name: string | null;
    /** UTC epoch ms this session was created, i.e. when this sign-in
     * happened. A Google re-auth (`prompt=login`) creates a new session, so
     * for a Google-only (no-password) account this is its live-credential
     * proof when deleting itself; see lib/services/accountDeletion.ts. */
    signedInAt: number;
  };
};

export const getServerAuthSession = async (): Promise<AppSession | null> => {
  // `cookies()` rather than the raw Cookie header: right after a sign-in
  // server action redirects, the page renders in the same response, and only
  // `cookies()` already holds the session cookie that action just set.
  const requestHeaders = new Headers(await headers());
  requestHeaders.set('cookie', (await cookies()).toString());
  const result = await auth.api.getSession({ headers: requestHeaders });
  if (!result) {
    return null;
  }
  return {
    user: {
      id: result.user.id,
      email: result.user.email,
      name: result.user.name ?? null,
      signedInAt: new Date(result.session.createdAt).getTime(),
    },
  };
};

const unauthorized = (): NextResponse =>
  NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

/**
 * For the handful of routes that need more than `session.user.id` (e.g. when
 * the user signed in) without re-deriving the 401 branch by hand.
 */
export const requireSession = async (): Promise<AppSession | NextResponse> => {
  const session = await getServerAuthSession();
  if (!session) {
    return unauthorized();
  }
  return session;
};

export const requireUserId = async (): Promise<string | NextResponse> => {
  const session = await requireSession();
  if (session instanceof NextResponse) {
    return session;
  }
  return session.user.id;
};
