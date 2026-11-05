const PREFIX: Record<string, string> = { cad: 'C$', usd: 'US$' };

/** `400, 'cad'` → "C$4", `450, 'cad'` → "C$4.50"; matches the pricing page. */
export const formatPlanPrice = (unitAmount: number, currency: string): string => {
  const amount = unitAmount / 100;
  const value = Number.isInteger(amount) ? String(amount) : amount.toFixed(2);
  return `${PREFIX[currency.toLowerCase()] ?? `${currency.toUpperCase()} `}${value}`;
};

export const intervalLabel = (interval: string): string =>
  interval === 'year' ? 'per year' : 'per month';
