import { describe, expect, it } from 'vitest';
import { buildPasswordResetEmail } from '@/lib/email/password-reset-email';
import { buildPasswordResetGoogleEmail } from '@/lib/email/password-reset-google-email';

describe('buildPasswordResetEmail', () => {
  const build = (resetUrl = 'https://ledger.test/reset-password?token=abc123') =>
    buildPasswordResetEmail({ appUrl: 'https://ledger.test/', resetUrl, minutesValid: 60 });

  it('links the button and the fallback text to the reset URL', () => {
    const { html } = build();
    const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
    expect(hrefs).toEqual([
      'https://ledger.test/reset-password?token=abc123',
      'https://ledger.test/reset-password?token=abc123',
    ]);
    expect(html).toContain('Choose a new password');
  });

  it('shows the expiry the caller passed in', () => {
    const { html, text } = build();
    expect(html).toContain('expires in 60 minutes');
    expect(text).toContain('expires in 60 minutes');
  });

  it('escapes the URL so it cannot break out of the attribute', () => {
    const { html } = build('https://ledger.test/reset-password?token="><script>x</script>');
    expect(html).not.toContain('<script>');
  });

  it('carries the raw link in the plain-text part', () => {
    const { subject, text } = build();
    expect(subject).toBe('Reset your Track a Loonie password');
    expect(text).toContain(
      'Choose a new password: https://ledger.test/reset-password?token=abc123',
    );
  });
});

describe('buildPasswordResetGoogleEmail', () => {
  it('points to the login page and carries no reset link', () => {
    const { subject, html, text } = buildPasswordResetGoogleEmail({
      appUrl: 'https://ledger.test',
      loginUrl: 'https://ledger.test/login',
    });
    const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);

    expect(subject).toBe('Sign in to Track a Loonie with Google');
    expect(hrefs).toEqual(['https://ledger.test/login']);
    expect(html).not.toContain('token=');
    expect(text).toContain('Sign in: https://ledger.test/login');
  });
});
