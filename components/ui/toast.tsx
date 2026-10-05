'use client';

import { useEffect } from 'react';
import { m } from 'framer-motion';
import { exitTransition, spring } from '@/lib/motion/tokens';

/** Animates out only when the caller renders it inside `AnimatePresence`. */
export const Toast = ({
  message,
  onUndo,
  onDismiss,
}: {
  message: string;
  onUndo?: () => void;
  onDismiss: () => void;
}): React.ReactElement => {
  useEffect(() => {
    const t = setTimeout(onDismiss, 6000);
    return () => clearTimeout(t);
  }, [onDismiss]);

  return (
    <m.div
      initial={{ opacity: 0, y: 20, scale: 0.96 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 8, transition: exitTransition }}
      transition={spring.bouncy}
      className="bg-ink text-paper fixed bottom-7 left-[280px] z-30 flex items-center gap-4.5 rounded-[14px] px-4.5 py-3.5 shadow-[0_18px_40px_rgba(0,0,0,.28)]"
    >
      <span className="text-[13.5px]">{message}</span>
      {onUndo && (
        <button type="button" onClick={onUndo} className="text-iris text-[13.5px] font-semibold">
          Undo
        </button>
      )}
    </m.div>
  );
};
