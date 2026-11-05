import type { FrontendImportBatch } from '@/lib/services/importBatches';

export class ServiceValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ServiceValidationError';
  }
}

/**
 * A commit was rejected because an active batch on the same account already used
 * this filename. Carries the conflicting batch so the route can name it in the 409
 * body and the client can offer an explicit override.
 */
export class DuplicateFilenameError extends Error {
  constructor(
    message: string,
    public readonly batch: FrontendImportBatch,
  ) {
    super(message);
    this.name = 'DuplicateFilenameError';
  }
}

/** Undo was requested for a batch that is already undone — a 409, not a crash. */
export class BatchAlreadyUndoneError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BatchAlreadyUndoneError';
  }
}

/**
 * A write was refused because it would violate reimbursement-link invariants
 * (e.g. deleting a linked transaction, reducing an amount below what's linked) —
 * a 409, not a 404. Subclasses ServiceValidationError so every existing
 * `instanceof ServiceValidationError` check still fires; routes that need the
 * distinct 409 status must check this subclass first.
 */
export class ReimbursementConflictError extends ServiceValidationError {
  constructor(message: string) {
    super(message);
    this.name = 'ReimbursementConflictError';
  }
}

/**
 * A Google-only account tried to delete itself without a fresh, interactive
 * Google re-authentication in the last few minutes — the passwordless
 * equivalent of `changePassword`'s "current password is incorrect". Kept
 * distinct from `ServiceValidationError` so the route can map it to its own
 * status and the client can render "Confirm with Google" instead of a
 * generic field error.
 */
export class GoogleReauthRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GoogleReauthRequiredError';
  }
}

/**
 * A write was refused because the user's plan doesn't allow it: a count limit
 * (`kind: 'limit'`) or a Plus-only feature (`kind: 'feature'`). Subclasses
 * ServiceValidationError so every existing 400 mapping still catches it;
 * gated routes check it first and answer 402 via `planErrorResponse`, whose
 * `code` the client uses to offer the upgrade.
 */
export class PlanRestrictionError extends ServiceValidationError {
  constructor(
    message: string,
    public readonly kind: 'limit' | 'feature',
    public readonly key: string,
  ) {
    super(message);
    this.name = 'PlanRestrictionError';
  }
}
