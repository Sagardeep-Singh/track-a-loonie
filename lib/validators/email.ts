import { z } from 'zod';

/**
 * The one canonical form for `User.email`: trimmed and lowercased. Every
 * write and every lookup goes through this, so "Jane@X.com" and
 * "jane@x.com" are the same account (migration
 * `normalize_user_emails` lowercased the rows stored before this).
 */
export const normalizeEmail = (email: string): string => email.trim().toLowerCase();

export const emailField = z
  .string()
  .trim()
  .email('Enter a valid email address.')
  .transform(normalizeEmail);
