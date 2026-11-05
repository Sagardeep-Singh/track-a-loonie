const DEFAULT_AFTER_SIGN_IN = '/dashboard';

/**
 * Where to land after signing in. Only in-app paths on an allowlist are
 * honoured, so `?next=` can't be used as an open redirect; anything else
 * falls back to the dashboard. Today that's the checkout a signed-out
 * visitor started from the pricing page.
 */
export const safeReturnTo = (value: unknown): string =>
  typeof value === 'string' && /^\/upgrade(?:\?[\w=&%.-]*)?$/.test(value)
    ? value
    : DEFAULT_AFTER_SIGN_IN;

/** `?next=` for an auth link, or '' when there's nothing to carry over. */
export const nextQuery = (next: string | undefined): string =>
  next && safeReturnTo(next) === next ? `?next=${encodeURIComponent(next)}` : '';
