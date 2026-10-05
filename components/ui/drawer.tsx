'use client';

import { useEffect, useRef } from 'react';
import { AnimatePresence, m } from 'framer-motion';
import { X } from 'lucide-react';
import { isDesktopViewport } from '@/lib/ui/viewport';
import { useIsDesktop } from '@/lib/ui/use-is-desktop';
import { exitTransition, spring } from '@/lib/motion/tokens';
import { cn } from '@/lib/cn';

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export const Drawer = ({
  open,
  onClose,
  title,
  children,
  className,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  className?: string;
}): React.ReactElement => {
  const panelRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<Element | null>(null);
  // Slides in from the right as a side panel at lg+; rises and fades in as a
  // full-screen surface below that.
  const hidden = useIsDesktop() ? { x: '100%' } : { y: 24, opacity: 0 };

  useEffect(() => {
    if (!open) return;

    triggerRef.current = document.activeElement;

    // Below lg this renders full-screen and must lock the background; at lg+
    // it's a 420px side panel, so the rest of the page — including the
    // transaction list next to it — stays visible and should stay scrollable.
    const shouldLockScroll = !isDesktopViewport();
    const previousOverflow = document.body.style.overflow;
    if (shouldLockScroll) {
      document.body.style.overflow = 'hidden';
    }

    const focusable = (): HTMLElement[] =>
      Array.from(panelRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR) ?? []);

    focusable()[0]?.focus();

    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;

      const elements = focusable();
      if (elements.length === 0) return;
      const first = elements[0];
      const last = elements[elements.length - 1];

      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      if (shouldLockScroll) {
        document.body.style.overflow = previousOverflow;
      }
      if (triggerRef.current instanceof HTMLElement) {
        triggerRef.current.focus();
      }
    };
  }, [open, onClose]);

  return (
    <AnimatePresence>
      {open && (
        <m.div
          key="drawer"
          ref={panelRef}
          initial={hidden}
          animate={{ x: 0, y: 0, opacity: 1 }}
          exit={{ ...hidden, transition: exitTransition }}
          transition={spring.snappy}
          role="dialog"
          aria-modal="true"
          aria-label={title}
          className={cn(
            // Full-screen below lg (a fixed 420px panel overflows a ~402px phone
            // viewport); unchanged right-side drawer at lg+.
            'border-line bg-paper-raised fixed inset-0 z-40 w-full overflow-auto border-l p-7 pb-8 shadow-[-18px_0_48px_rgba(0,0,0,.16)] lg:inset-y-0 lg:right-0 lg:left-auto lg:w-[420px]',
            className,
          )}
        >
          <div className="flex items-center justify-between">
            <span className="text-ink-muted text-[11px] font-semibold tracking-[0.1em] uppercase">
              {title}
            </span>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="text-ink-muted focus-visible:ring-iris rounded focus-visible:ring-2 focus-visible:outline-none"
            >
              <X size={18} />
            </button>
          </div>
          {children}
        </m.div>
      )}
    </AnimatePresence>
  );
};
