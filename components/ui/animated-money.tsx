'use client';

import { useEffect, useRef } from 'react';
import { useReducedMotion } from 'framer-motion';

const FORMAT = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const DURATION_MS = 900;

/** Ease-out cubic: fast start, gentle landing on the real value. */
const easeOut = (t: number): number => 1 - (1 - t) ** 3;

/**
 * A dollar amount that counts up from $0.00 on mount and from its previous
 * value on change. Hand-rolled on requestAnimationFrame rather than motion's
 * `useSpring`, which would pull the animation engine into first-load JS.
 * Screen readers get the final value from a visually hidden copy.
 */
export const AnimatedMoney = ({
  value,
  className,
}: {
  value: number;
  className?: string;
}): React.ReactElement => {
  const ref = useRef<HTMLSpanElement>(null);
  const shown = useRef(0);
  const reduced = useReducedMotion();

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const from = shown.current;
    const render = (n: number): void => {
      shown.current = n;
      el.textContent = FORMAT.format(n);
    };
    if (reduced || from === value) {
      render(value);
      return;
    }
    let frame = 0;
    const start = performance.now();
    const tick = (now: number): void => {
      const t = Math.min(1, (now - start) / DURATION_MS);
      render(from + (value - from) * easeOut(t));
      if (t < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [value, reduced]);

  return (
    <span className={className}>
      <span ref={ref} aria-hidden="true">
        {FORMAT.format(0)}
      </span>
      <span className="sr-only">{FORMAT.format(value)}</span>
    </span>
  );
};
