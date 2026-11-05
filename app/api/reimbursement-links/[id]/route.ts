import { NextResponse } from 'next/server';
import { requireUserId } from '@/lib/auth/session';
import { updateReimbursementLinkSchema } from '@/lib/validators/reimbursements';
import { deleteReimbursementLink, updateReimbursementLink } from '@/lib/services/reimbursements';
import { ReimbursementConflictError, ServiceValidationError } from '@/lib/services/common';
import { planErrorResponse } from '@/lib/http/planError';

type RouteParams = { params: Promise<{ id: string }> };

export const PATCH = async (request: Request, { params }: RouteParams): Promise<NextResponse> => {
  const userId = await requireUserId();
  if (userId instanceof NextResponse) {
    return userId;
  }

  const { id } = await params;
  const parsed = updateReimbursementLinkSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  try {
    return NextResponse.json(await updateReimbursementLink(userId, id, parsed.data));
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
    return NextResponse.json(await deleteReimbursementLink(userId, id));
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
