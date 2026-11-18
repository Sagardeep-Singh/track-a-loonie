import { NextResponse } from 'next/server';
import { requireSession } from '@/lib/auth/session';
import { deleteAccountSchema } from '@/lib/validators/account-deletion';
import { deleteUserAccount } from '@/lib/services/accountDeletion';
import { GoogleReauthRequiredError, ServiceValidationError } from '@/lib/services/common';

export const DELETE = async (request: Request): Promise<NextResponse> => {
  // `requireSession` rather than `requireUserId`: account deletion also needs
  // the session's sign-in time as a Google-only user's live-credential proof.
  const session = await requireSession();
  if (session instanceof NextResponse) {
    return session;
  }

  const parsed = deleteAccountSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
  }

  try {
    // Read from the session, never the request body — a client-supplied
    // "I reauthenticated" flag would be trivially spoofable; the session row
    // is not.
    const result = await deleteUserAccount(session.user.id, parsed.data, session.user.signedInAt);
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof GoogleReauthRequiredError) {
      return NextResponse.json(
        { error: error.message, requiresGoogleReauth: true },
        { status: 428 },
      );
    }
    if (error instanceof ServiceValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }
};
