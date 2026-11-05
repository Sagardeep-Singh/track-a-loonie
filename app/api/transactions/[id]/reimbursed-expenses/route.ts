import { NextResponse } from 'next/server';
import { requireUserId } from '@/lib/auth/session';
import { listReimbursedExpenses } from '@/lib/services/reimbursements';
import { ServiceValidationError } from '@/lib/services/common';

type RouteParams = { params: Promise<{ id: string }> };

export const GET = async (_request: Request, { params }: RouteParams): Promise<NextResponse> => {
  const userId = await requireUserId();
  if (userId instanceof NextResponse) {
    return userId;
  }

  const { id } = await params;
  try {
    return NextResponse.json(await listReimbursedExpenses(userId, id));
  } catch (error) {
    if (error instanceof ServiceValidationError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    throw error;
  }
};
