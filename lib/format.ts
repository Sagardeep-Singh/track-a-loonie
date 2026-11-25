import { daysInMonth, todayIn } from '@/lib/date';

// `toLocaleDateString()` depends on the runtime's locale/timezone, which can
// differ between the server (SSR) and the browser (hydration) and causes a
// hydration mismatch. Pin locale and timeZone explicitly so the output is
// identical everywhere. Transaction dates are stored as UTC midnight, so
// formatting in UTC shows the calendar date the user entered, not a day
// shifted by the viewer's local offset.
const DATE_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: 'UTC',
  month: 'numeric',
  day: 'numeric',
  year: 'numeric',
});

export const formatDate = (date: string | Date): string =>
  DATE_FORMATTER.format(typeof date === 'string' ? new Date(date) : date);

/** YYYYMM of the real current month in `timeZone` (the viewer's, from
 * `getViewerTimeZone`, on the server), for defaults and flagging a
 * still-in-progress month. */
export const currentMonthNumber = (timeZone = 'UTC'): number => todayIn(timeZone).month;

/** Days elapsed so far in `month` if it's the current month in `timeZone`,
 * else the full month length (a past month is complete; a future one hasn't
 * started). */
export const daysElapsedInMonth = (month: number, timeZone = 'UTC'): number => {
  const today = todayIn(timeZone);
  if (month === today.month) return today.day;
  return month > today.month ? 0 : daysInMonth(month);
};

/** "1st", "2nd", "3rd", "4th"... for a day-of-month number. */
export const ordinal = (n: number): string => {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
};
