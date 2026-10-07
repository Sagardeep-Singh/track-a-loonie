'use client';

import { BottomSheet } from '@/components/ui/bottom-sheet';
import { Modal } from '@/components/ui/modal';
import { useIsDesktop } from '@/lib/ui/use-is-desktop';

/**
 * A centered `Modal` at lg and a `BottomSheet` below it, for forms that
 * should sit under the thumb on a phone. Picks one at render time instead of
 * mounting both behind CSS, so the form's ids and autofocus exist once.
 */
export const ResponsiveDialog = ({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
}): React.ReactElement =>
  useIsDesktop() ? (
    <Modal open={open} onClose={onClose} title={title}>
      {children}
    </Modal>
  ) : (
    <BottomSheet open={open} onClose={onClose} title={title}>
      {children}
    </BottomSheet>
  );
