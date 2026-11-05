import { betterAuth, type BetterAuthOptions } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import { nextCookies } from 'better-auth/next-js';
import bcrypt from 'bcryptjs';
import { prisma } from '@/lib/db/prisma';
import { appBaseUrl } from '@/lib/http/appUrl';

const googleClientId = process.env.AUTH_GOOGLE_ID;
const googleClientSecret = process.env.AUTH_GOOGLE_SECRET;

const BCRYPT_ROUNDS = 12;

/**
 * Better Auth endpoints the app never calls over HTTP. Signup, password
 * reset, password change, email verification and account deletion stay on
 * our own server actions and services (rate limits, no-enumeration
 * responses, logging); email sign-in runs through `signInAction`, which
 * rate-limits before calling `auth.api.signInEmail`. Leaving these mounted
 * would let anyone skip all of that by POSTing to /api/auth/* directly.
 * `disabledPaths` only blocks the HTTP router: server-side `auth.api.*`
 * calls still work.
 */
export const DISABLED_PATHS = [
  '/sign-in/email',
  '/sign-up/email',
  '/sign-in/social',
  '/request-password-reset',
  '/forget-password',
  '/reset-password',
  '/change-password',
  '/set-password',
  '/send-verification-email',
  '/verify-email',
  '/change-email',
  '/update-user',
  '/delete-user',
  '/link-social',
  '/unlink-account',
  '/revoke-session',
  '/revoke-sessions',
  '/revoke-other-sessions',
];

export const authOptions = {
  baseURL: appBaseUrl(),
  secret: process.env.BETTER_AUTH_SECRET,
  database: prismaAdapter(prisma, { provider: 'postgresql' }),
  // IDs come from Prisma's `@default(cuid())`, same as every other table.
  advanced: { database: { generateId: false } },
  // A finance app shouldn't keep a stolen or
  // forgotten session alive for a month, so sessions end after a week and
  // refresh at most daily (rolling for anyone using it regularly). No
  // `cookieCache`: every request reads the session row, so deleting an
  // account (which cascades to its sessions) or changing a password signs
  // out every device on its next request, not when a cache expires.
  session: { expiresIn: 60 * 60 * 24 * 7, updateAge: 60 * 60 * 24 },
  // Renamed so Better Auth's `account` can't collide with the bank/credit
  // `Account` model.
  account: {
    modelName: 'authAccount',
    // A Google sign-in links to an existing account with the same email,
    // but only once that account's email is verified (Better Auth's
    // default). Linking into an unverified row would let someone who
    // pre-registered a victim's address with a password take over the
    // victim's Google sign-in.
    accountLinking: { enabled: true, trustedProviders: ['google'] },
    // Google is only used for identity, but Better Auth still stores the
    // tokens Google hands back. Encrypted at rest (keyed off
    // BETTER_AUTH_SECRET) so a database leak doesn't hand them out.
    encryptOAuthTokens: true,
  },
  emailAndPassword: {
    enabled: true,
    // Signup goes through `signUpAction` / `createUser`.
    disableSignUp: true,
    // Existing hashes are bcrypt (migrated from NextAuth), so keep bcrypt
    // rather than Better Auth's default scrypt.
    password: {
      hash: (password: string): Promise<string> => bcrypt.hash(password, BCRYPT_ROUNDS),
      verify: ({ hash, password }: { hash: string; password: string }): Promise<boolean> =>
        bcrypt.compare(password, hash),
    },
  },
  socialProviders:
    googleClientId && googleClientSecret
      ? { google: { clientId: googleClientId, clientSecret: googleClientSecret } }
      : {},
  // Rate limits live in lib/services/rateLimit.ts (database-backed, shared
  // across instances) and run in the server actions. Better Auth's limiter
  // doesn't apply to server-side `auth.api.*` calls anyway.
  rateLimit: { enabled: false },
  disabledPaths: DISABLED_PATHS,
  telemetry: { enabled: false },
  // Must stay last: it writes Better Auth's Set-Cookie headers through
  // `next/headers` when an `auth.api.*` call runs inside a server action.
  plugins: [nextCookies()],
} satisfies BetterAuthOptions;

export const auth = betterAuth(authOptions);
