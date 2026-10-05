import { renderEmailHtml, type TransactionalEmail } from '@/lib/email/layout';

/**
 * Sent instead of a reset link when the account signed up with Google and
 * has no password. The forgot-password form shows the same response either
 * way, so this email is where the owner finds out what to do instead.
 */
export const buildPasswordResetGoogleEmail = ({
  appUrl,
  loginUrl,
}: {
  appUrl: string;
  loginUrl: string;
}): TransactionalEmail => {
  const subject = 'Sign in to Track a Loonie with Google';

  const html = renderEmailHtml({
    appUrl,
    subject,
    preheader: 'Your account uses Google sign-in, so there is no password to reset.',
    heading: 'Use Google to sign in',
    intro:
      'Someone asked to reset the password for this Track a Loonie account. It signs in with Google and has no password, so there is nothing to reset. Use "Continue with Google" on the sign-in page instead.',
    buttonLabel: 'Go to sign in',
    buttonUrl: loginUrl,
    footer: "If you didn't ask for this, you can ignore this email. Your account is unchanged.",
  });

  const text = [
    'Use Google to sign in',
    '',
    'Someone asked to reset the password for this Track a Loonie account.',
    'It signs in with Google and has no password, so there is nothing to reset. Use "Continue with Google" on the sign-in page instead.',
    '',
    `Sign in: ${loginUrl}`,
    '',
    "If you didn't ask for this, you can ignore this email. Your account is unchanged.",
  ].join('\n');

  return { subject, html, text };
};
