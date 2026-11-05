import { z } from 'zod';

export const checkoutSchema = z.object({
  priceId: z.string().trim().min(1, 'Choose a plan').max(255),
});

export type CheckoutInput = z.infer<typeof checkoutSchema>;
