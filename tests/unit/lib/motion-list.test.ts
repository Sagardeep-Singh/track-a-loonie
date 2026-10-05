import { describe, expect, it } from 'vitest';
import {
  SWIPE_DISMISS_OFFSET,
  SWIPE_DISMISS_VELOCITY,
  isSmallListChange,
  shouldDismissSheet,
} from '@/lib/motion/list';

describe('isSmallListChange', () => {
  it('treats an unchanged list as small', () => {
    expect(isSmallListChange(['a', 'b'], ['a', 'b'])).toBe(true);
  });

  it('treats a reorder with the same ids as small', () => {
    expect(isSmallListChange(['a', 'b', 'c'], ['c', 'a', 'b'])).toBe(true);
  });

  it('counts a single removal or addition as small', () => {
    expect(isSmallListChange(['a', 'b', 'c'], ['a', 'c'])).toBe(true);
    expect(isSmallListChange(['a', 'c'], ['a', 'b', 'c'])).toBe(true);
  });

  it('allows exactly the max number of changes', () => {
    expect(isSmallListChange(['a', 'b', 'c', 'd'], ['a'])).toBe(true);
  });

  it('rejects one change past the max', () => {
    expect(isSmallListChange(['a', 'b', 'c', 'd', 'e'], ['a'])).toBe(false);
  });

  it('rejects a full page swap', () => {
    expect(isSmallListChange(['a', 'b', 'c'], ['d', 'e', 'f'])).toBe(false);
  });

  it('treats empty to empty as small', () => {
    expect(isSmallListChange([], [])).toBe(true);
  });

  it('respects a custom max', () => {
    expect(isSmallListChange(['a', 'b'], [], 1)).toBe(false);
    expect(isSmallListChange(['a', 'b'], [], 2)).toBe(true);
  });
});

describe('shouldDismissSheet', () => {
  it('dismisses past the distance threshold', () => {
    expect(shouldDismissSheet(SWIPE_DISMISS_OFFSET + 1, 0)).toBe(true);
  });

  it('keeps the sheet open on a short, slow drag', () => {
    expect(shouldDismissSheet(SWIPE_DISMISS_OFFSET - 1, 0)).toBe(false);
  });

  it('dismisses on a fast downward flick even when short', () => {
    expect(shouldDismissSheet(10, SWIPE_DISMISS_VELOCITY + 100)).toBe(true);
  });

  it('never dismisses on an upward drag', () => {
    expect(shouldDismissSheet(-40, -900)).toBe(false);
  });

  it('keeps the sheet open exactly at both thresholds', () => {
    expect(shouldDismissSheet(SWIPE_DISMISS_OFFSET, SWIPE_DISMISS_VELOCITY)).toBe(false);
  });
});
