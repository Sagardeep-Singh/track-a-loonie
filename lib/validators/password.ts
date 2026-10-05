import { z } from 'zod';

export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_BYTES = 72;

// bcrypt silently truncates input beyond 72 UTF-8 bytes rather than throwing, so
// the cap prevents two different long passwords resolving to the same hash.
const newPasswordField = z
  .string()
  .min(MIN_PASSWORD_LENGTH, `New password must be at least ${MIN_PASSWORD_LENGTH} characters.`)
  .refine((value) => new TextEncoder().encode(value).length <= MAX_PASSWORD_BYTES, {
    message: `New password is too long (${MAX_PASSWORD_BYTES} bytes max — accented or emoji characters count for more than one).`,
  });

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Enter your current password.'),
  newPassword: newPasswordField,
});

export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;

export const forgotPasswordSchema = z.object({
  email: z.string().trim().email('Enter a valid email address.'),
});

export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;

export const resetPasswordSchema = z.object({
  token: z.string().min(1, 'This reset link is missing its token.'),
  newPassword: newPasswordField,
});

export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;
