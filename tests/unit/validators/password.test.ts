import { describe, expect, it } from 'vitest';
import {
  MAX_PASSWORD_BYTES,
  MIN_PASSWORD_LENGTH,
  changePasswordSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
} from '@/lib/validators/password';

const parse = (currentPassword: string, newPassword: string) =>
  changePasswordSchema.safeParse({ currentPassword, newPassword });

describe('changePasswordSchema', () => {
  it('rejects a blank current password', () => {
    const result = parse('', 'a'.repeat(MIN_PASSWORD_LENGTH));

    expect(result.success).toBe(false);
    expect(result.error?.issues[0].message).toBe('Enter your current password.');
  });

  it(`rejects a new password one character under ${MIN_PASSWORD_LENGTH}`, () => {
    const result = parse('current', 'a'.repeat(MIN_PASSWORD_LENGTH - 1));

    expect(result.success).toBe(false);
    expect(result.error?.issues[0].message).toBe(
      `New password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
    );
  });

  it(`accepts a new password of exactly ${MIN_PASSWORD_LENGTH} characters`, () => {
    expect(parse('current', 'a'.repeat(MIN_PASSWORD_LENGTH)).success).toBe(true);
  });

  it(`accepts a new password of exactly ${MAX_PASSWORD_BYTES} bytes`, () => {
    expect(parse('current', 'a'.repeat(MAX_PASSWORD_BYTES)).success).toBe(true);
  });

  it(`rejects a new password one byte over ${MAX_PASSWORD_BYTES}`, () => {
    const result = parse('current', 'a'.repeat(MAX_PASSWORD_BYTES + 1));

    expect(result.success).toBe(false);
    expect(result.error?.issues[0].message).toContain('too long');
  });

  it('counts multibyte characters by byte, not by code point', () => {
    // 36 two-byte characters = 72 bytes but only 36 JS characters.
    const atCap = 'é'.repeat(MAX_PASSWORD_BYTES / 2);
    expect(new TextEncoder().encode(atCap).length).toBe(MAX_PASSWORD_BYTES);
    expect(parse('current', atCap).success).toBe(true);

    const overCap = `${atCap}é`;
    expect(overCap.length).toBeLessThanOrEqual(MAX_PASSWORD_BYTES);
    expect(parse('current', overCap).success).toBe(false);
  });

  it('strips confirmNewPassword rather than forwarding it to the service', () => {
    const result = changePasswordSchema.safeParse({
      currentPassword: 'current',
      newPassword: 'a'.repeat(MIN_PASSWORD_LENGTH),
      confirmNewPassword: 'a'.repeat(MIN_PASSWORD_LENGTH),
    });

    expect(result.success).toBe(true);
    expect(result.data).not.toHaveProperty('confirmNewPassword');
  });
});

describe('forgotPasswordSchema', () => {
  it('trims and accepts a valid email', () => {
    const result = forgotPasswordSchema.safeParse({ email: '  a@example.com ' });

    expect(result.success).toBe(true);
    expect(result.data?.email).toBe('a@example.com');
  });

  it('rejects a malformed email', () => {
    const result = forgotPasswordSchema.safeParse({ email: 'not-an-email' });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0].message).toBe('Enter a valid email address.');
  });
});

describe('resetPasswordSchema', () => {
  it('rejects an empty token', () => {
    const result = resetPasswordSchema.safeParse({
      token: '',
      newPassword: 'a'.repeat(MIN_PASSWORD_LENGTH),
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0].message).toBe('This reset link is missing its token.');
  });

  it('applies the same new-password rules as change password', () => {
    expect(
      resetPasswordSchema.safeParse({
        token: 't',
        newPassword: 'a'.repeat(MIN_PASSWORD_LENGTH - 1),
      }).success,
    ).toBe(false);
    expect(
      resetPasswordSchema.safeParse({ token: 't', newPassword: 'a'.repeat(MAX_PASSWORD_BYTES + 1) })
        .success,
    ).toBe(false);
    expect(
      resetPasswordSchema.safeParse({ token: 't', newPassword: 'a'.repeat(MIN_PASSWORD_LENGTH) })
        .success,
    ).toBe(true);
  });
});
