'use client';

import { useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/cn';

const MONTH_SHORT = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short' });
const MONTH_LONG = new Intl.DateTimeFormat('en-US', {
  timeZone: 'UTC',
  month: 'long',
  year: 'numeric',
});
const monthDate = (month: number): Date =>
  new Date(Date.UTC(Math.floor(month / 100), (month % 100) - 1, 1));

/**
 * Inline YYYYMM picker: a year stepper over a 12-month grid, the same look as
 * the period picker's grid. Used instead of `<input type="month">`, which
 * Firefox and desktop Safari render as a plain text box.
 */
export const MonthPicker = ({
  value,
  onChange,
  min,
  max,
  label,
}: {
  value: number | null;
  onChange: (month: number) => void;
  /** earliest selectable YYYYMM month, inclusive */
  min?: number;
  /** latest selectable YYYYMM month, inclusive */
  max?: number;
  /** accessible name of the month group, e.g. "Reach it by" */
  label: string;
}): React.ReactElement => {
  const startYear = Math.floor((value ?? min ?? 0) / 100) || new Date().getUTCFullYear();
  const [viewYear, setViewYear] = useState(startYear);
  const minYear = min === undefined ? null : Math.floor(min / 100);
  const maxYear = max === undefined ? null : Math.floor(max / 100);

  return (
    <div role="group" aria-label={label}>
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={() => setViewYear((y) => y - 1)}
          disabled={minYear !== null && viewYear <= minYear}
          aria-label="Previous year"
          className="text-ink-muted hover:text-ink -ml-2 flex size-9 items-center justify-center disabled:opacity-30"
        >
          <ChevronLeft size={16} />
        </button>
        <span className="font-mono text-[13px] font-medium">{viewYear}</span>
        <button
          type="button"
          onClick={() => setViewYear((y) => y + 1)}
          disabled={maxYear !== null && viewYear >= maxYear}
          aria-label="Next year"
          className="text-ink-muted hover:text-ink -mr-2 flex size-9 items-center justify-center disabled:opacity-30"
        >
          <ChevronRight size={16} />
        </button>
      </div>
      <div className="mt-1.5 grid grid-cols-4 gap-1.5">
        {Array.from({ length: 12 }, (_, i) => viewYear * 100 + i + 1).map((m) => {
          const disabled = (min !== undefined && m < min) || (max !== undefined && m > max);
          const selected = m === value;
          return (
            <button
              key={m}
              type="button"
              disabled={disabled}
              aria-pressed={selected}
              aria-label={MONTH_LONG.format(monthDate(m))}
              onClick={() => onChange(m)}
              className={cn(
                'rounded-[10px] py-2.5 text-[13px] font-medium disabled:cursor-not-allowed disabled:opacity-30',
                selected ? 'bg-iris text-paper-raised' : 'text-ink hover:bg-paper',
              )}
            >
              {MONTH_SHORT.format(monthDate(m))}
            </button>
          );
        })}
      </div>
    </div>
  );
};
