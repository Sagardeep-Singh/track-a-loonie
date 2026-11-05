import { NextResponse } from 'next/server';
import { requireUserId } from '@/lib/auth/session';
import { createAccountSchema } from '@/lib/validators/accounts';
import { createAccount, listAccounts } from '@/lib/services/accounts';
import { ServiceValidationError } from '@/lib/services/common';
import { planErrorResponse } from '@/lib/http/planError';

export const GET = async (): Promise<NextResponse> => {
  const userId = await requireUserId();
  if (userId instanceof NextResponse) {
    return userId;
  }

  const accounts = await listAccounts(userId);
  return NextResponse.json(accounts);
};

export const POST = async (request: Request): Promise<NextResponse> => {
  const userId = await requireUserId();
  if (userId instanceof NextResponse) {
    return userId;
  }

  const parsed = createAccountSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  try {
    const account = await createAccount(userId, parsed.data);
    return NextResponse.json(account, { status: 201 });
  } catch (error) {
    const planError = planErrorResponse(error);
    if (planError) return planError;
    if (error instanceof ServiceValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }
};
