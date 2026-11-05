import { NextResponse } from 'next/server';
import { requireUserId } from '@/lib/auth/session';
import { createReimbursementLinkSchema } from '@/lib/validators/reimbursements';
import { createReimbursementLink } from '@/lib/services/reimbursements';
import { ReimbursementConflictError, ServiceValidationError } from '@/lib/services/common';
import { planErrorResponse } from '@/lib/http/planError';

export const POST = async (request: Request): Promise<NextResponse> => {
  const userId = await requireUserId();
  if (userId instanceof NextResponse) {
    return userId;
  }

  const parsed = createReimbursementLinkSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  try {
    const summary = await createReimbursementLink(userId, parsed.data);
    return NextResponse.json(summary, { status: 201 });
  } catch (error) {
    const planError = planErrorResponse(error);
    if (planError) return planError;
    if (error instanceof ReimbursementConflictError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    if (error instanceof ServiceValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }
};
