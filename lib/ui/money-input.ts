/**
 * Pure parsing for the shared money text field, kept out of the component so
 * it is unit-testable under vitest's `environment: 'node'`. The field shows
 * what the user typed (commas allowed) and hands callers the plain number
 * string the validators expect.
 */

// optional minus, digits with any commas, then at most one decimal point
const TYPED_AMOUNT = /^-?[\d,]*\.?\d*$/;

/**
 * Cleans one keystroke or paste: drops `$` and spaces, then returns the
 * display text, or null when the result isn't a money shape (the edit is
 * ignored). `6,303.89` and `$6303.89` both pass.
 */
export const sanitizeMoneyInput = (raw: string): string | null => {
  const cleaned = raw.replace(/[\s$]/g, '');
  return TYPED_AMOUNT.test(cleaned) ? cleaned : null;
};

/** display text to the plain value callers store and send: `6,303.89` → `6303.89` */
export const plainMoney = (display: string): string => display.replace(/,/g, '');

/** groups the whole-dollar part with commas, leaving decimals as typed */
export const groupMoney = (plain: string): string => {
  const match = /^(-?)(\d+)(\.\d*)?$/.exec(plain);
  if (!match) return plain;
  const [, sign, whole, decimals = ''] = match;
  return `${sign}${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${decimals}`;
};
