import { cookies } from 'next/headers';
import { isValidTimeZone } from '@/lib/date';

/** IANA zone of the viewer's browser, written by `TimezoneCookieSync`. */
export const TIMEZONE_COOKIE = 'tz';

/** Server-side read of the viewer's timezone; UTC until the browser reports one. */
export const getViewerTimeZone = async (): Promise<string> => {
  const store = await cookies();
  const value = store.get(TIMEZONE_COOKIE)?.value;
  return value && isValidTimeZone(value) ? value : 'UTC';
};
