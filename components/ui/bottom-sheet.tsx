'use client';

import { useEffect, useRef } from 'react';
import { AnimatePresence, m, useDragControls } from 'framer-motion';
import { X } from 'lucide-react';
import { exitTransition, spring } from '@/lib/motion/tokens';
import { shouldDismissSheet } from '@/lib/motion/list';
import { isDesktopViewport } from '@/lib/ui/viewport';
import { cn } from '@/lib/cn';

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Mobile bottom sheet. Same focus-trap / Escape / scroll-lock contract as
 * `Drawer` (which is hard-coded to a right-side panel and can't be
 * parameterised into this without conditionalising every style line), plus a
 * dimming backdrop — a sheet without one reads as broken rather than modal.
 *
 * Slides up on open and back down on close, and can be dragged down by its
 * handle to dismiss. Drag starts only from the handle so scrolling the
 * sheet's own content never moves the sheet.
 */
export const BottomSheet = ({
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
  const dragControls = useDragControls();

  useEffect(() => {
    if (!open) return;
    // Callers render this behind an `lg:hidden` wrapper, which hides it but
    // does not unmount it — without this guard an open desktop popover would
    // lock body scroll through its hidden mobile twin.
    if (isDesktopViewport()) return;

    triggerRef.current = document.activeElement;
    document.body.style.overflow = 'hidden';

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
      // Cleared outright rather than restored from a snapshot: a sheet can be
      // mounted alongside another (hidden) overlay whose own cleanup runs in
      // tree order, and restoring 'hidden' afterwards would leave the page
      // permanently unscrollable.
      document.body.style.removeProperty('overflow');
      if (triggerRef.current instanceof HTMLElement) {
        triggerRef.current.focus();
      }
    };
  }, [open, onClose]);

  return (
    <AnimatePresence>
      {open && (
        <m.div
          key="backdrop"
          onClick={onClose}
          aria-hidden="true"
          className="fixed inset-0 z-40 bg-black/40"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0, transition: exitTransition }}
          transition={{ duration: 0.2 }}
        />
      )}
      {open && (
        <m.div
          key="sheet"
          ref={panelRef}
          role="dialog"
          aria-modal="true"
          aria-label={title}
          className={cn(
            'border-line bg-paper-raised fixed inset-x-0 bottom-0 z-50 max-h-[85vh] overflow-y-auto rounded-t-[20px] border-t px-5 pb-5 shadow-[0_-18px_48px_rgba(0,0,0,.18)]',
            className,
          )}
          style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 20px)' }}
          initial={{ y: '100%' }}
          animate={{ y: 0 }}
          exit={{ y: '100%', transition: exitTransition }}
          transition={spring.snappy}
          drag="y"
          dragListener={false}
          dragControls={dragControls}
          dragConstraints={{ top: 0, bottom: 0 }}
          dragElastic={{ top: 0.05, bottom: 1 }}
          onDragEnd={(_, info) => {
            if (shouldDismissSheet(info.offset.y, info.velocity.y)) onClose();
          }}
        >
          <div
            data-testid="sheet-handle"
            aria-hidden="true"
            onPointerDown={(e) => dragControls.start(e)}
            className="flex cursor-grab touch-none justify-center pt-2.5 pb-3 active:cursor-grabbing"
          >
            <span className="bg-line h-1.5 w-10 rounded-full" />
          </div>
          <div className="mb-4 flex items-center justify-between">
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
