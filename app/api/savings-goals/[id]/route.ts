import { NextResponse } from 'next/server';
import { requireUserId } from '@/lib/auth/session';
import { ServiceValidationError } from '@/lib/services/common';
import {
  deleteSavingsGoal,
  setSavingsGoalArchived,
  updateSavingsGoal,
} from '@/lib/services/savingsGoals';
import { archiveSavingsGoalSchema, updateSavingsGoalSchema } from '@/lib/validators/savings-goals';

type RouteParams = { params: Promise<{ id: string }> };

/** a body with `archived` archives or restores; anything else edits the goal */
export const PATCH = async (request: Request, { params }: RouteParams): Promise<NextResponse> => {
  const userId = await requireUserId();
  if (userId instanceof NextResponse) {
    return userId;
  }

  const { id } = await params;
  const body: unknown = await request.json();
  const archive = archiveSavingsGoalSchema.safeParse(body);
  const update = archive.success ? null : updateSavingsGoalSchema.safeParse(body);
  if (update && !update.success) {
    return NextResponse.json({ error: update.error.flatten() }, { status: 400 });
  }

  try {
    if (archive.success) {
      await setSavingsGoalArchived(userId, id, archive.data.archived);
    } else if (update?.success) {
      await updateSavingsGoal(userId, id, update.data);
    }
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    if (error instanceof ServiceValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
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
    await deleteSavingsGoal(userId, id);
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    if (error instanceof ServiceValidationError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    throw error;
  }
};
