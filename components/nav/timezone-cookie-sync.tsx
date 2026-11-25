'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

// Mirrors TIMEZONE_COOKIE in lib/timezone-cookie.ts, which is server-only.
const TIMEZONE_COOKIE = 'tz';

/**
 * Reports the browser's timezone to the server so "this month" and "today"
 * follow the viewer's clock (see `todayIn`). Re-renders once when the cookie
 * was missing or stale, so the first visit and a trip across zones correct
 * themselves without a manual reload.
 */
export const TimezoneCookieSync = (): null => {
  const router = useRouter();
  useEffect(() => {
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (!timeZone) return;
    const current = document.cookie
      .split('; ')
      .find((c) => c.startsWith(`${TIMEZONE_COOKIE}=`))
      ?.slice(TIMEZONE_COOKIE.length + 1);
    if (current && decodeURIComponent(current) === timeZone) return;
    document.cookie = `${TIMEZONE_COOKIE}=${encodeURIComponent(timeZone)}; path=/; max-age=31536000; samesite=lax`;
    router.refresh();
  }, [router]);
  return null;
};
