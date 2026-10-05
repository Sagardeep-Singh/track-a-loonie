import { describe, expect, it } from 'vitest';
import { emailField, normalizeEmail } from '@/lib/validators/email';

describe('normalizeEmail', () => {
  it('trims and lowercases', () => {
    expect(normalizeEmail('  Jane.Doe@Example.COM ')).toBe('jane.doe@example.com');
  });

  it('leaves an already-normal address unchanged', () => {
    expect(normalizeEmail('jane@example.com')).toBe('jane@example.com');
  });
});

describe('emailField', () => {
  it('outputs the normalized address', () => {
    expect(emailField.parse(' Jane@Example.com ')).toBe('jane@example.com');
  });

  it('rejects a malformed address', () => {
    const result = emailField.safeParse('Not-An-Email');

    expect(result.success).toBe(false);
    expect(result.error?.issues[0].message).toBe('Enter a valid email address.');
  });
});
