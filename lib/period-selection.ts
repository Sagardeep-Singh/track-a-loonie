import { daysInMonth, fromDateKey, toDateKey } from '@/lib/date';
import type { Period } from '@/lib/statement';

/**
 * What the shared period selector has picked. Month-only pages (Overview,
 * Budgets, Trends) only ever produce `month`; Transactions and Categorize
 * also allow `all` and `custom`, stored in the URL as `from`/`to`
 * (yyyy-mm-dd, both inclusive).
 */
export type PeriodSelection =
  | { kind: 'all' }
  | { kind: 'month'; month: number }
  | { kind: 'custom'; from: string | null; to: string | null };

export type DateRange = { from: string | null; to: string | null };

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** A `yyyy-mm-dd` string that is a real calendar date, else null — a
 * hand-edited URL must fall back to "no bound", never throw. */
export const parseDateParam = (value: string | null | undefined): string | null =>
  value && fromDateKey(value) ? value : null;

/** First and last day (inclusive) of a `YYYYMM` month as yyyy-mm-dd. */
export const monthToRange = (month: number): { from: string; to: string } => {
  const year = Math.floor(month / 100);
  const m = month % 100;
  return {
    from: `${year}-${pad2(m)}-01`,
    to: `${year}-${pad2(m)}-${pad2(daysInMonth(month))}`,
  };
};

/** A half-open `Period` (end exclusive) as an inclusive yyyy-mm-dd range. */
export const periodToRange = (period: Period): { from: string; to: string } => ({
  from: toDateKey(period.start),
  to: toDateKey(new Date(period.end.getTime() - 24 * 60 * 60 * 1000)),
});

/** Reads a `from`/`to` pair back as a selection: nothing set is all time, an
 * exact calendar month is that month, anything else is a custom range. */
export const selectionFromRange = ({ from, to }: DateRange): PeriodSelection => {
  if (!from && !to) return { kind: 'all' };
  if (from && to && from.endsWith('-01') && from.slice(0, 7) === to.slice(0, 7)) {
    const month = Number(from.slice(0, 4)) * 100 + Number(from.slice(5, 7));
    if (monthToRange(month).to === to) return { kind: 'month', month };
  }
  return { kind: 'custom', from, to };
};

export const rangeFromSelection = (selection: PeriodSelection): DateRange => {
  if (selection.kind === 'all') return { from: null, to: null };
  if (selection.kind === 'month') return monthToRange(selection.month);
  return { from: selection.from, to: selection.to };
};

/** Half-open UTC bounds for a Prisma `date` filter; a missing side is open. */
export const rangeToDates = ({ from, to }: DateRange): { gte?: Date; lt?: Date } => {
  const bounds: { gte?: Date; lt?: Date } = {};
  if (from) bounds.gte = new Date(`${from}T00:00:00Z`);
  if (to) bounds.lt = new Date(new Date(`${to}T00:00:00Z`).getTime() + 24 * 60 * 60 * 1000);
  return bounds;
};

const MONTH_LABEL = new Intl.DateTimeFormat('en-US', {
  timeZone: 'UTC',
  month: 'long',
  year: 'numeric',
});
const DAY_LABEL = new Intl.DateTimeFormat('en-US', {
  timeZone: 'UTC',
  month: 'short',
  day: 'numeric',
});
const DAY_YEAR_LABEL = new Intl.DateTimeFormat('en-US', {
  timeZone: 'UTC',
  month: 'short',
  day: 'numeric',
  year: 'numeric',
});

export const monthLabel = (month: number): string =>
  MONTH_LABEL.format(new Date(Date.UTC(Math.floor(month / 100), (month % 100) - 1, 1)));

const toDate = (value: string): Date => new Date(`${value}T00:00:00Z`);

/** The selector pill's text: "September 2026", "All time", "Sep 3 – Sep 20, 2026". */
export const periodSelectionLabel = (selection: PeriodSelection): string => {
  if (selection.kind === 'all') return 'All time';
  if (selection.kind === 'month') return monthLabel(selection.month);
  const { from, to } = selection;
  if (from && to) {
    const sameYear = from.slice(0, 4) === to.slice(0, 4);
    const start = (sameYear ? DAY_LABEL : DAY_YEAR_LABEL).format(toDate(from));
    return `${start} – ${DAY_YEAR_LABEL.format(toDate(to))}`;
  }
  if (from) return `From ${DAY_YEAR_LABEL.format(toDate(from))}`;
  return `Until ${DAY_YEAR_LABEL.format(toDate(to!))}`;
};

/**
 * The last period the user picked, shared by every screen so the selector
 * holds its value when moving between pages. A cookie rather than
 * localStorage because the month-only screens are server-rendered and must
 * read it before rendering. An explicit URL param always wins over it.
 */
export const PERIOD_COOKIE = 'period';

/** 'all' | 'm:202609' | 'r:2026-09-03:2026-09-20' (either range side may be empty). */
export const encodePeriodCookie = (selection: PeriodSelection): string => {
  if (selection.kind === 'all') return 'all';
  if (selection.kind === 'month') return `m:${selection.month}`;
  return `r:${selection.from ?? ''}:${selection.to ?? ''}`;
};

export const decodePeriodCookie = (value: string | null | undefined): PeriodSelection | null => {
  if (!value) return null;
  if (value === 'all') return { kind: 'all' };
  const month = /^m:(\d{6})$/.exec(value);
  if (month) {
    const m = Number(month[1]);
    return m % 100 >= 1 && m % 100 <= 12 ? { kind: 'month', month: m } : null;
  }
  const range = /^r:([^:]*):([^:]*)$/.exec(value);
  if (range) {
    const from = parseDateParam(range[1]);
    const to = parseDateParam(range[2]);
    return from || to ? selectionFromRange({ from, to }) : null;
  }
  return null;
};

/** The month a month-only screen shows for a stored selection: a range maps
 * to the month it ends in (its most recent data), all time to `fallback`. */
export const selectionMonth = (selection: PeriodSelection | null, fallback: number): number => {
  if (!selection || selection.kind === 'all') return fallback;
  if (selection.kind === 'month') return selection.month;
  const day = selection.to ?? selection.from!;
  return Number(day.slice(0, 4)) * 100 + Number(day.slice(5, 7));
};

/** Client-side write; a year is long enough to feel sticky, short enough to expire. */
export const writePeriodCookie = (selection: PeriodSelection): void => {
  if (typeof document === 'undefined') return;
  document.cookie = `${PERIOD_COOKIE}=${encodePeriodCookie(selection)}; path=/; max-age=31536000; samesite=lax`;
};
