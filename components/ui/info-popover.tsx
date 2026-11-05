'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { Info } from 'lucide-react';

/**
 * A small info icon that toggles a short description. Click-to-open rather
 * than hover so it works on touch; Escape and an outside click close it.
 */
export const InfoPopover = ({
  label,
  children,
}: {
  /** accessible name for the icon button, e.g. "About transfers" */
  label: string;
  children: React.ReactNode;
}): React.ReactElement => {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);
  const popoverId = useId();

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      // the drawer closes on a window-level Escape; only close the popover
      event.stopPropagation();
      setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <span ref={rootRef} className="relative inline-flex">
      <button
        type="button"
        aria-label={label}
        aria-expanded={open}
        aria-controls={popoverId}
        onClick={() => setOpen((o) => !o)}
        className="text-ink-muted hover:text-ink rounded-full p-0.5"
      >
        <Info size={14} />
      </button>
      {open && (
        <span
          id={popoverId}
          role="tooltip"
          className="border-line bg-paper-raised text-ink absolute top-full left-1/2 z-30 mt-1.5 w-56 -translate-x-1/2 rounded-lg border px-3 py-2 text-xs font-normal shadow-lg"
        >
          {children}
        </span>
      )}
    </span>
  );
};
