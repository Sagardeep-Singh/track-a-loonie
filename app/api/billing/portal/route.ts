import { NextResponse } from 'next/server';
import { requireUserId } from '@/lib/auth/session';
import { createPortalSession } from '@/lib/services/billing';
import { ServiceValidationError } from '@/lib/services/common';

export const POST = async (): Promise<NextResponse> => {
  const userId = await requireUserId();
  if (userId instanceof NextResponse) {
    return userId;
  }

  try {
    return NextResponse.json(await createPortalSession(userId));
  } catch (error) {
    if (error instanceof ServiceValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }
};
