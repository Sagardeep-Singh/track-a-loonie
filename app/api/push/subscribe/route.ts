import { NextResponse } from 'next/server';
import { requireUserId } from '@/lib/auth/session';
import { savePushSubscriptionSchema } from '@/lib/validators/push';
import { savePushSubscription } from '@/lib/services/pushSubscriptions';
import { planErrorResponse } from '@/lib/http/planError';

export const POST = async (request: Request): Promise<NextResponse> => {
  const userId = await requireUserId();
  if (userId instanceof NextResponse) {
    return userId;
  }

  const parsed = savePushSubscriptionSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
  }

  try {
    const subscription = await savePushSubscription(
      userId,
      parsed.data,
      request.headers.get('user-agent'),
    );
    return NextResponse.json(subscription, { status: 201 });
  } catch (error) {
    const planError = planErrorResponse(error);
    if (planError) return planError;
    throw error;
  }
};
