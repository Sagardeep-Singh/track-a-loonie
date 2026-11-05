import { NextResponse } from 'next/server';
import { requireUserId } from '@/lib/auth/session';
import { updateAccountSchema } from '@/lib/validators/accounts';
import { deleteAccount, updateAccount } from '@/lib/services/accounts';
import { ReimbursementConflictError, ServiceValidationError } from '@/lib/services/common';
import { planErrorResponse } from '@/lib/http/planError';

type RouteParams = { params: Promise<{ id: string }> };

export const PATCH = async (request: Request, { params }: RouteParams): Promise<NextResponse> => {
  const userId = await requireUserId();
  if (userId instanceof NextResponse) {
    return userId;
  }

  const { id } = await params;
  const parsed = updateAccountSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  try {
    const account = await updateAccount(userId, id, parsed.data);
    return NextResponse.json(account);
  } catch (error) {
    const planError = planErrorResponse(error);
    if (planError) return planError;
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
    await deleteAccount(userId, id);
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
