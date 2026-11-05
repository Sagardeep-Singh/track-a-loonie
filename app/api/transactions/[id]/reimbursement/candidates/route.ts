import { NextResponse } from 'next/server';
import { requireUserId } from '@/lib/auth/session';
import { listReimbursementCandidatesQuerySchema } from '@/lib/validators/reimbursements';
import { listReimbursementCandidates } from '@/lib/services/reimbursements';
import { ServiceValidationError } from '@/lib/services/common';
import { planErrorResponse } from '@/lib/http/planError';

type RouteParams = { params: Promise<{ id: string }> };

export const GET = async (request: Request, { params }: RouteParams): Promise<NextResponse> => {
  const userId = await requireUserId();
  if (userId instanceof NextResponse) {
    return userId;
  }

  const { id } = await params;
  const url = new URL(request.url);
  const parsed = listReimbursementCandidatesQuerySchema.safeParse({
    search: url.searchParams.get('search') ?? undefined,
    limit: url.searchParams.get('limit') ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  try {
    return NextResponse.json(await listReimbursementCandidates(userId, id, parsed.data));
  } catch (error) {
    const planError = planErrorResponse(error);
    if (planError) return planError;
    if (error instanceof ServiceValidationError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    throw error;
  }
};
