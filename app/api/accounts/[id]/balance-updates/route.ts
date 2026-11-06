import { NextResponse } from 'next/server';
import { requireUserId } from '@/lib/auth/session';
import { createBalanceUpdateSchema } from '@/lib/validators/accounts';
import { createBalanceUpdate } from '@/lib/services/accountBalances';
import { ServiceValidationError } from '@/lib/services/common';

type RouteParams = { params: Promise<{ id: string }> };

export const POST = async (request: Request, { params }: RouteParams): Promise<NextResponse> => {
  const userId = await requireUserId();
  if (userId instanceof NextResponse) {
    return userId;
  }

  const { id } = await params;
  const parsed = createBalanceUpdateSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  try {
    const update = await createBalanceUpdate(userId, id, parsed.data);
    return NextResponse.json(update, { status: 201 });
  } catch (error) {
    if (error instanceof ServiceValidationError) {
      const status = error.message === 'Account not found' ? 404 : 400;
      return NextResponse.json({ error: error.message }, { status });
    }
    throw error;
  }
};
