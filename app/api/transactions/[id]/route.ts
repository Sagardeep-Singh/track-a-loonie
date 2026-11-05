import { NextResponse } from 'next/server';
import { requireUserId } from '@/lib/auth/session';
import { updateTransactionSchema } from '@/lib/validators/transactions';
import { deleteTransaction, updateTransaction } from '@/lib/services/transactions';
import { ReimbursementConflictError, ServiceValidationError } from '@/lib/services/common';
import { planErrorResponse } from '@/lib/http/planError';

type RouteParams = { params: Promise<{ id: string }> };

export const PATCH = async (request: Request, { params }: RouteParams): Promise<NextResponse> => {
  const userId = await requireUserId();
  if (userId instanceof NextResponse) {
    return userId;
  }

  const { id } = await params;
  const parsed = updateTransactionSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  try {
    return NextResponse.json(await updateTransaction(userId, id, parsed.data));
  } catch (error) {
    const planError = planErrorResponse(error);
    if (planError) return planError;
    if (error instanceof ReimbursementConflictError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    if (error instanceof ServiceValidationError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    throw error;
  }
};

export const DELETE = async (_request: Request, { params }: RouteParams): Promise<NextResponse> => {
  const userId = await requireUserId();
  if (userId instanceof NextResponse) {
    return userId;
  }

  const { id } = await params;
  try {
    await deleteTransaction(userId, id);
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    const planError = planErrorResponse(error);
    if (planError) return planError;
    if (error instanceof ReimbursementConflictError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    if (error instanceof ServiceValidationError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    throw error;
  }
};
