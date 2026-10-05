import { NextResponse } from 'next/server';
import { requireUserId } from '@/lib/auth/session';
import { moveMoneySchema } from '@/lib/validators/zero-based';
import { moveMoney } from '@/lib/services/zeroBased';
import { ServiceValidationError } from '@/lib/services/common';

export const POST = async (request: Request): Promise<NextResponse> => {
  const userId = await requireUserId();
  if (userId instanceof NextResponse) {
    return userId;
  }

  const parsed = moveMoneySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
  }

  try {
    return NextResponse.json(await moveMoney(userId, parsed.data));
  } catch (error) {
    if (error instanceof ServiceValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }
};
