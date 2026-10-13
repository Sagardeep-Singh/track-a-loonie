import { NextResponse } from 'next/server';
import { requireUserId } from '@/lib/auth/session';
import { currentMonthNumber } from '@/lib/format';
import { ServiceValidationError } from '@/lib/services/common';
import { createSavingsGoal, listSavingsGoals } from '@/lib/services/savingsGoals';
import { createSavingsGoalSchema, savingsGoalsQuerySchema } from '@/lib/validators/savings-goals';

export const GET = async (request: Request): Promise<NextResponse> => {
  const userId = await requireUserId();
  if (userId instanceof NextResponse) {
    return userId;
  }

  const url = new URL(request.url);
  const parsed = savingsGoalsQuerySchema.safeParse({
    month: url.searchParams.get('month') ?? undefined,
    includeArchived: url.searchParams.get('includeArchived') ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  return NextResponse.json(
    await listSavingsGoals(userId, parsed.data.month ?? currentMonthNumber(), {
      includeArchived: parsed.data.includeArchived,
    }),
  );
};

export const POST = async (request: Request): Promise<NextResponse> => {
  const userId = await requireUserId();
  if (userId instanceof NextResponse) {
    return userId;
  }

  const parsed = createSavingsGoalSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  try {
    const goal = await createSavingsGoal(userId, parsed.data);
    return NextResponse.json(goal, { status: 201 });
  } catch (error) {
    if (error instanceof ServiceValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }
};
