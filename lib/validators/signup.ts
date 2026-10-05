import { z } from 'zod';
import { emailField } from '@/lib/validators/email';
import { MAX_PASSWORD_BYTES, MIN_PASSWORD_LENGTH } from '@/lib/validators/password';

export const signUpSchema = z.object({
  name: z.string().trim().min(1, 'Enter your name.').max(120),
  email: emailField,
  password: z
    .string()
    .min(MIN_PASSWORD_LENGTH, `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`)
    .refine((value) => new TextEncoder().encode(value).length <= MAX_PASSWORD_BYTES, {
      message: `Password is too long (${MAX_PASSWORD_BYTES} bytes max — accented or emoji characters count for more than one).`,
    }),
});

export type SignUpInput = z.infer<typeof signUpSchema>;
