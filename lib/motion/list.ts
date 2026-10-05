/** Past this distance (px), releasing a dragged sheet closes it. */
export const SWIPE_DISMISS_OFFSET = 70;
/** A downward flick faster than this (px/s) closes the sheet regardless of distance. */
export const SWIPE_DISMISS_VELOCITY = 500;

/**
 * Whether a list update is small enough to animate row by row. Pagination,
 * filter or period changes swap most rows at once, and animating every one of
 * those in and out reads as noise rather than feedback.
 */
export const isSmallListChange = (
  prevIds: readonly string[],
  nextIds: readonly string[],
  max = 3,
): boolean => {
  const prev = new Set(prevIds);
  const next = new Set(nextIds);
  let changed = 0;
  for (const id of prev) if (!next.has(id)) changed += 1;
  for (const id of next) if (!prev.has(id)) changed += 1;
  return changed <= max;
};

/** Drag-to-dismiss decision for the bottom sheet, from motion's drag-end info. */
export const shouldDismissSheet = (offsetY: number, velocityY: number): boolean =>
  offsetY > SWIPE_DISMISS_OFFSET || velocityY > SWIPE_DISMISS_VELOCITY;
