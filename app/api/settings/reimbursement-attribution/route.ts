import { NextResponse } from 'next/server';
import { requireUserId } from '@/lib/auth/session';
import { reimbursementAttributionSchema } from '@/lib/validators/zero-based';
import { setReimbursementAttribution } from '@/lib/services/zeroBased';

export const PATCH = async (request: Request): Promise<NextResponse> => {
  const userId = await requireUserId();
  if (userId instanceof NextResponse) {
    return userId;
  }

  const parsed = reimbursementAttributionSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
  }

  return NextResponse.json(await setReimbursementAttribution(userId, parsed.data));
};
