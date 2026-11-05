import { NextResponse } from 'next/server';
import { requireUserId } from '@/lib/auth/session';
import { checkoutSchema } from '@/lib/validators/billing';
import { createCheckoutSession } from '@/lib/services/billing';
import { ServiceValidationError } from '@/lib/services/common';

export const POST = async (request: Request): Promise<NextResponse> => {
  const userId = await requireUserId();
  if (userId instanceof NextResponse) {
    return userId;
  }

  const parsed = checkoutSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
  }

  try {
    return NextResponse.json(await createCheckoutSession(userId, parsed.data.priceId));
  } catch (error) {
    if (error instanceof ServiceValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }
};
