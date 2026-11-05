import { NextResponse } from 'next/server';
import { PlanRestrictionError } from '@/lib/services/common';

/**
 * 402 for a plan restriction, null for anything else. Gated routes call this
 * before their ServiceValidationError → 400 branch, since the plan error is
 * a subclass of it.
 */
export const planErrorResponse = (error: unknown): NextResponse | null =>
  error instanceof PlanRestrictionError
    ? NextResponse.json(
        { error: error.message, code: `plan_${error.kind}`, key: error.key },
        { status: 402 },
      )
    : null;
