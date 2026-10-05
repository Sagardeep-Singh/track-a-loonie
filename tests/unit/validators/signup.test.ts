import { describe, expect, it } from 'vitest';
import { MIN_PASSWORD_LENGTH } from '@/lib/validators/password';
import { signUpSchema } from '@/lib/validators/signup';

const VALID_PASSWORD = 'a'.repeat(MIN_PASSWORD_LENGTH);

const parse = (overrides: Partial<{ name: string; email: string; password: string }> = {}) =>
  signUpSchema.safeParse({
    name: 'Jane Doe',
    email: 'jane@example.com',
    password: VALID_PASSWORD,
    ...overrides,
  });

describe('signUpSchema', () => {
  it('accepts a valid signup', () => {
    expect(parse().success).toBe(true);
  });

  it('rejects a blank name', () => {
    const result = parse({ name: '' });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0].message).toBe('Enter your name.');
  });

  it('trims the name', () => {
    const result = parse({ name: '  Jane  ' });
    expect(result.success).toBe(true);
    expect(result.data?.name).toBe('Jane');
  });

  it('stores the email trimmed and lowercased', () => {
    const result = parse({ email: '  Jane@Example.COM ' });

    expect(result.success).toBe(true);
    expect(result.data?.email).toBe('jane@example.com');
  });

  it('rejects an invalid email', () => {
    const result = parse({ email: 'not-an-email' });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0].message).toBe('Enter a valid email address.');
  });

  it(`rejects a password under ${MIN_PASSWORD_LENGTH} characters`, () => {
    const result = parse({ password: 'a'.repeat(MIN_PASSWORD_LENGTH - 1) });
    expect(result.success).toBe(false);
  });
});
