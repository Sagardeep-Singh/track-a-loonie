import { NextResponse } from 'next/server';
import { requireUserId } from '@/lib/auth/session';
import {
  createTransactionSchema,
  listTransactionsQuerySchema,
  transactionsPageQuerySchema,
} from '@/lib/validators/transactions';
import { createTransaction, listTransactions } from '@/lib/services/transactions';
import { getTransactionsPage, toTransactionsPageRequest } from '@/lib/services/transactionsPage';
import { ReimbursementConflictError, ServiceValidationError } from '@/lib/services/common';
import { planErrorResponse } from '@/lib/http/planError';

export const GET = async (request: Request): Promise<NextResponse> => {
  const userId = await requireUserId();
  if (userId instanceof NextResponse) {
    return userId;
  }

  const url = new URL(request.url);
  if (url.searchParams.get('paginated') === '1') {
    return getPaginated(userId, url.searchParams);
  }
  const parsed = listTransactionsQuerySchema.safeParse({
    accountId: url.searchParams.get('accountId') ?? undefined,
    categoryId: url.searchParams.get('categoryId') ?? undefined,
    batchId: url.searchParams.get('batchId') ?? undefined,
    from: url.searchParams.get('from') ?? undefined,
    to: url.searchParams.get('to') ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  return NextResponse.json(await listTransactions(userId, parsed.data));
};

const PAGE_QUERY_KEYS = Object.keys(transactionsPageQuerySchema.shape);

/** `?paginated=1`: the Transactions page envelope. */
const getPaginated = async (userId: string, params: URLSearchParams): Promise<NextResponse> => {
  const parsed = transactionsPageQuerySchema.safeParse(
    Object.fromEntries(PAGE_QUERY_KEYS.map((key) => [key, params.get(key) ?? undefined])),
  );
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  try {
    return NextResponse.json(
      await getTransactionsPage(userId, toTransactionsPageRequest(parsed.data)),
    );
  } catch (error) {
    const planError = planErrorResponse(error);
    if (planError) return planError;
    if (error instanceof ServiceValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }
};

export const POST = async (request: Request): Promise<NextResponse> => {
  const userId = await requireUserId();
  if (userId instanceof NextResponse) {
    return userId;
  }

  const parsed = createTransactionSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  try {
    const transaction = await createTransaction(userId, parsed.data);
    return NextResponse.json(transaction, { status: 201 });
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
