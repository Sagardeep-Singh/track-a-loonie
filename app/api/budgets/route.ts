import { NextResponse } from 'next/server';
import { requireUserId } from '@/lib/auth/session';
import { createBudgetSchema } from '@/lib/validators/budgets';
import { createBudget, listBudgets } from '@/lib/services/budgets';
import { ServiceValidationError } from '@/lib/services/common';
import { currentMonthNumber } from '@/lib/format';
import { getViewerTimeZone } from '@/lib/timezone-cookie';

export const GET = async (request: Request): Promise<NextResponse> => {
  const userId = await requireUserId();
  if (userId instanceof NextResponse) {
    return userId;
  }

  const url = new URL(request.url);
  const monthParam = url.searchParams.get('month');
  const month = monthParam ? Number(monthParam) : currentMonthNumber(await getViewerTimeZone());

  return NextResponse.json(await listBudgets(userId, month));
};

export const POST = async (request: Request): Promise<NextResponse> => {
  const userId = await requireUserId();
  if (userId instanceof NextResponse) {
    return userId;
  }

  const parsed = createBudgetSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  try {
    const budget = await createBudget(userId, parsed.data);
    return NextResponse.json(budget, { status: 201 });
  } catch (error) {
    if (error instanceof ServiceValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }
};
