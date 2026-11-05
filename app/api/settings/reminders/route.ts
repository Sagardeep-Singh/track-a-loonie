import { NextResponse } from 'next/server';
import { requireUserId } from '@/lib/auth/session';
import { updateReminderPreferenceSchema } from '@/lib/validators/reminders';
import { updateReminderPreference } from '@/lib/services/reminders';
import { planErrorResponse } from '@/lib/http/planError';

export const PATCH = async (request: Request): Promise<NextResponse> => {
  const userId = await requireUserId();
  if (userId instanceof NextResponse) {
    return userId;
  }

  const parsed = updateReminderPreferenceSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
  }

  try {
    return NextResponse.json(await updateReminderPreference(userId, parsed.data));
  } catch (error) {
    const planError = planErrorResponse(error);
    if (planError) return planError;
    throw error;
  }
};
