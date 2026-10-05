import {
  BODY_FONT,
  COLORS,
  MONO_FONT,
  escapeHtml,
  renderEmailHtml,
  type TransactionalEmail,
} from '@/lib/email/layout';

/**
 * `appUrl` is the app's origin (for the logo); `resetUrl` is the full
 * one-time link. `minutesValid` is shown in the copy so it can't drift from
 * the token TTL the caller actually uses.
 */
export const buildPasswordResetEmail = ({
  appUrl,
  resetUrl,
  minutesValid,
}: {
  appUrl: string;
  resetUrl: string;
  minutesValid: number;
}): TransactionalEmail => {
  const subject = 'Reset your Track a Loonie password';
  const href = escapeHtml(resetUrl);

  const html = renderEmailHtml({
    appUrl,
    subject,
    preheader: `Someone asked to reset your password. The link expires in ${minutesValid} minutes.`,
    heading: 'Reset your password',
    intro:
      'Someone asked to reset the password for this Track a Loonie account. Use the button below to choose a new one.',
    buttonLabel: 'Choose a new password',
    buttonUrl: resetUrl,
    detailsHtml: `
            <p class="l-muted" style="margin:28px 0 8px;font-family:${BODY_FONT};font-size:13px;line-height:1.5;color:${COLORS.inkMuted};">The link expires in ${minutesValid} minutes and works once. If the button doesn't work, paste this into your browser:</p>
            <p class="l-code" style="margin:0;padding:10px 12px;border-radius:10px;background-color:${COLORS.paperSunk};font-family:${MONO_FONT};font-size:12px;line-height:1.5;word-break:break-all;color:${COLORS.inkMuted};"><a class="l-link" href="${href}" target="_blank" style="color:${COLORS.accent};text-decoration:none;">${href}</a></p>`,
    footer:
      "If you didn't ask for this, you can ignore this email. Your password stays the same until the link is used.",
  });

  const text = [
    'Reset your password',
    '',
    'Someone asked to reset the password for this Track a Loonie account.',
    '',
    `Choose a new password: ${resetUrl}`,
    '',
    `The link expires in ${minutesValid} minutes and works once.`,
    '',
    "If you didn't ask for this, you can ignore this email. Your password stays the same until the link is used.",
  ].join('\n');

  return { subject, html, text };
};
