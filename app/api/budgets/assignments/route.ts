import { NextResponse } from 'next/server';
import { requireUserId } from '@/lib/auth/session';
import { setAssignmentSchema, zbbMonthQuerySchema } from '@/lib/validators/zero-based';
import { getZbbMonth, setAssignment } from '@/lib/services/zeroBased';
import { ServiceValidationError } from '@/lib/services/common';

export const PUT = async (request: Request): Promise<NextResponse> => {
  const userId = await requireUserId();
  if (userId instanceof NextResponse) {
    return userId;
  }

  const parsed = setAssignmentSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
  }

  try {
    return NextResponse.json(await setAssignment(userId, parsed.data));
  } catch (error) {
    if (error instanceof ServiceValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }
};

export const GET = async (request: Request): Promise<NextResponse> => {
  const userId = await requireUserId();
  if (userId instanceof NextResponse) {
    return userId;
  }

  const parsed = zbbMonthQuerySchema.safeParse({
    month: new URL(request.url).searchParams.get('month'),
  });
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
  }

  try {
    return NextResponse.json(await getZbbMonth(userId, parsed.data.month));
  } catch (error) {
    if (error instanceof ServiceValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }
};
