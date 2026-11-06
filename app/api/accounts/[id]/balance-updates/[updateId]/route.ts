import { NextResponse } from 'next/server';
import { requireUserId } from '@/lib/auth/session';
import { deleteBalanceUpdate } from '@/lib/services/accountBalances';
import { ServiceValidationError } from '@/lib/services/common';

type RouteParams = { params: Promise<{ id: string; updateId: string }> };

export const DELETE = async (_request: Request, { params }: RouteParams): Promise<NextResponse> => {
  const userId = await requireUserId();
  if (userId instanceof NextResponse) {
    return userId;
  }

  const { id, updateId } = await params;
  try {
    await deleteBalanceUpdate(userId, id, updateId);
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    if (error instanceof ServiceValidationError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    throw error;
  }
};
