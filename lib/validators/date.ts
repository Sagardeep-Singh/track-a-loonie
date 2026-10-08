import { z } from 'zod';
import { fromDateKey, toDateKey } from '@/lib/date';

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/;

/** A real `YYYY-MM-DD` calendar date, kept as the string. */
export const dateKeySchema = z
  .string()
  .trim()
  .refine((value) => fromDateKey(value) !== null, 'Enter a date as YYYY-MM-DD');

/**
 * A calendar date, stored as UTC midnight. Accepts `YYYY-MM-DD` (date inputs)
 * or a full ISO timestamp with a zone (a `date` echoed back from an API
 * response), which is reduced to its UTC day. Anything else is rejected
 * rather than handed to `new Date()`, which would read it in the server's
 * local timezone.
 */
export const calendarDateSchema = z
  .union([z.date(), z.string().trim()])
  .transform((value, ctx): Date => {
    let date: Date | null = null;
    if (value instanceof Date) {
      date = Number.isNaN(value.getTime()) ? null : fromDateKey(toDateKey(value));
    } else if (ISO_TIMESTAMP.test(value)) {
      const parsed = new Date(value);
      date = Number.isNaN(parsed.getTime()) ? null : fromDateKey(toDateKey(parsed));
    } else {
      date = fromDateKey(value);
    }
    if (!date) {
      ctx.addIssue({ code: 'custom', message: 'Enter a date as YYYY-MM-DD' });
      return z.NEVER;
    }
    return date;
  });
