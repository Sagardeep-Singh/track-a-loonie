const LOCAL_URL = 'http://localhost:3000';

const withScheme = (host: string): string => `https://${host.replace(/\/$/, '')}`;

/**
 * The app's public origin, for absolute links that leave the app (emails)
 * and Better Auth's `baseURL` (the Google OAuth redirect URI).
 *
 * `BETTER_AUTH_URL` wins when set. On Vercel it is usually unset, so this
 * falls back to Vercel's system env vars: the production domain in production and, on a preview, the branch alias
 * (stable across pushes to that branch, so an emailed link survives a
 * redeploy), else that deployment's own URL. localhost is only the last
 * resort, for local dev.
 *
 * Deliberately never derived from the request's Host header: a spoofed Host
 * would let someone send a victim a verification link pointing at another
 * domain.
 */
export const appBaseUrl = (env: NodeJS.ProcessEnv = process.env): string => {
  if (env.BETTER_AUTH_URL) return env.BETTER_AUTH_URL.replace(/\/$/, '');
  if (env.VERCEL_ENV === 'production' && env.VERCEL_PROJECT_PRODUCTION_URL) {
    return withScheme(env.VERCEL_PROJECT_PRODUCTION_URL);
  }
  if (env.VERCEL_ENV === 'preview' && env.VERCEL_BRANCH_URL) {
    return withScheme(env.VERCEL_BRANCH_URL);
  }
  if (env.VERCEL_URL) return withScheme(env.VERCEL_URL);
  return LOCAL_URL;
};
