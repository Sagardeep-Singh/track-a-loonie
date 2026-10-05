import type { NextAuthConfig } from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import Google from 'next-auth/providers/google';
import bcrypt from 'bcryptjs';
import { prisma } from '@/lib/db/prisma';
import { findOrCreateGoogleUser } from '@/lib/services/users';
import { normalizeEmail } from '@/lib/validators/email';
import { checkRateLimit, RateLimitedError } from '@/lib/services/rateLimit';
import { clientIpFromHeaders } from '@/lib/http/clientIp';
import { AuthRateLimitedError } from '@/lib/auth/errors';

const googleClientId = process.env.AUTH_GOOGLE_ID;
const googleClientSecret = process.env.AUTH_GOOGLE_SECRET;

// Credential-stuffing/brute-force guard for the one unauthenticated route
// that checks a password. Two scopes so a single leaked-password list run
// against many emails (IP-scoped) and repeated guesses against one account
// (email-scoped) are both bounded, independently of each other.
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_EMAIL_LIMIT = 10;
const LOGIN_IP_LIMIT = 30;

// The e2e suite logs in as the same dev user dozens of times per run across
// many specs — a real user never does this, but a shared-account test suite
// legitimately does, and this limit exists to stop the former, not the
// latter. Server-only env var, read once at module load, never request
// input — same shape as AI_ANTHROPIC_BASE_URL's test-only override.
const rateLimitDisabled = process.env.E2E_DISABLE_RATE_LIMIT === '1';

export const authConfig: NextAuthConfig = {
  // Tightened from NextAuth's 30-day default: a finance app shouldn't keep a
  // stolen or forgotten session alive for a month, so tokens expire after a
  // week and refresh at most daily (rolling for anyone using it regularly).
  session: { strategy: 'jwt', maxAge: 60 * 60 * 24 * 7, updateAge: 60 * 60 * 24 },
  pages: { signIn: '/login' },
  providers: [
    ...(googleClientId && googleClientSecret
      ? [Google({ clientId: googleClientId, clientSecret: googleClientSecret })]
      : []),
    Credentials({
      credentials: {
        email: { label: 'Email', type: 'email' },
        password: { label: 'Password', type: 'password' },
      },
      authorize: async (credentials, request) => {
        const password = credentials?.password;
        if (typeof credentials?.email !== 'string' || typeof password !== 'string') {
          return null;
        }
        const email = normalizeEmail(credentials.email);

        // Checked before the user lookup so a guess against a nonexistent
        // email still counts — otherwise account enumeration would be free.
        if (!rateLimitDisabled) {
          const ip = clientIpFromHeaders(request.headers);
          try {
            await checkRateLimit('login:ip', ip, LOGIN_IP_LIMIT, LOGIN_WINDOW_MS);
            await checkRateLimit('login:email', email, LOGIN_EMAIL_LIMIT, LOGIN_WINDOW_MS);
          } catch (error) {
            if (error instanceof RateLimitedError) {
              throw new AuthRateLimitedError();
            }
            throw error;
          }
        }

        const user = await prisma.user.findUnique({ where: { email } });
        if (!user || !user.passwordHash) {
          return null;
        }

        const valid = await bcrypt.compare(password, user.passwordHash);
        if (!valid) {
          return null;
        }

        return { id: user.id, email: user.email, name: user.name };
      },
    }),
  ],
  callbacks: {
    jwt: async ({ token, user, account }) => {
      if (user) {
        if (account?.provider === 'google') {
          if (!user.email) return token;
          const dbUser = await findOrCreateGoogleUser(user.email, user.name ?? null);
          token.userId = dbUser.id;
          // Marks this token as having just completed a live, interactive
          // Google sign-in — including a re-sign-in triggered by
          // `reauthenticateWithGoogleAction`'s `prompt: 'login'`, which is
          // exactly the same code path. Read by account deletion for a
          // Google-only user as its live-credential proof, in place of
          // `currentPassword` (see lib/services/accountDeletion.ts).
          token.reauthenticatedAt = Date.now();
        } else {
          token.userId = user.id;
        }
        token.name = user.name ?? token.name;
      }
      // Deleting an account must take effect everywhere immediately, not
      // just for the tab that did the deleting — this is the one callback
      // upstream of every route's `requireUserId()` guard and the protected
      // layout's redirect, so a `null` here fires all of them with zero
      // changes to the existing route handlers. No `checkedAt`
      // throttle: caching this for even a minute would let a deleted user's
      // other devices keep working past the atomic delete they're supposed
      // to be locked out of immediately.
      //
      // Skipped when `user` was just set above: sign-in/sign-up already
      // loaded or created that row in this same request, so re-checking its
      // existence a line later would be a pointless second lookup — only
      // subsequent reads (no `user` on this call) need it.
      if (!user && token.userId) {
        const exists = await prisma.user.findUnique({
          where: { id: token.userId as string },
          select: { id: true },
        });
        if (!exists) return null;
      }
      return token;
    },
    session: ({ session, token }) => {
      if (session.user) {
        session.user.id = token.userId as string;
        session.user.name = (token.name as string | null) ?? session.user.name;
        session.user.reauthenticatedAt = (token.reauthenticatedAt as number | undefined) ?? null;
      }
      return session;
    },
  },
};
