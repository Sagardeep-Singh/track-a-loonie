import { allocateSpread, SPREAD_MAX_MONTHS, SPREAD_MIN_MONTHS, spreadEndMonth } from '@/lib/spread';
import { monthInputToYyyymm } from '@/lib/transactions/transaction-payload';

const MONTH_LABEL = new Intl.DateTimeFormat('en-US', {
  timeZone: 'UTC',
  month: 'short',
  year: 'numeric',
});
const MONEY = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

/** "Jan 2026" for a YYYYMM month. */
export const formatSpreadMonth = (month: number): string =>
  MONTH_LABEL.format(new Date(Date.UTC(Math.floor(month / 100), (month % 100) - 1, 1)));

/**
 * The form's live preview line, e.g. "$300.00 a month, Jan 2026 to Dec 2026".
 * null while the inputs can't make a valid spread yet. The first (largest)
 * share is shown, since remainder cents go to the earliest months.
 */
export const spreadPreview = (
  amount: string,
  startMonth: string,
  months: string,
): string | null => {
  const start = monthInputToYyyymm(startMonth);
  const count = Number(months);
  const cents = Math.round(Number(amount) * 100);
  if (
    start === null ||
    months === '' ||
    !Number.isInteger(count) ||
    count < SPREAD_MIN_MONTHS ||
    count > SPREAD_MAX_MONTHS
  ) {
    return null;
  }
  const range = `${formatSpreadMonth(start)} to ${formatSpreadMonth(spreadEndMonth(start, count))}`;
  if (!Number.isFinite(cents) || cents <= 0) return `Over ${count} months, ${range}`;
  const [first] = allocateSpread(cents, start, count);
  return `${MONEY.format(first.cents / 100)} a month, ${range}`;
};
