'use client';

import { m } from 'framer-motion';
import { spring } from '@/lib/motion/tokens';
import { useReducedTransition } from '@/lib/motion/use-reduced-transition';

/**
 * Budgets ring (limits cards and zero-based rows): three-tier color (sky under pace, iris near the limit,
 * rose over) instead of the shared `Ring`'s two-tone alertAt threshold, and
 * a second inner ring showing the overage fraction once a budget is blown
 * past 100% — neither exists in `components/ui/ring.tsx`, which stays
 * untouched since Overview/other screens rely on its current behavior.
 */
export const BudgetRing = ({
  fraction,
  size = 84,
}: {
  fraction: number;
  /** rendered px; the drawing scales from its 84px viewBox */
  size?: number;
}): React.ReactElement => {
  const over = fraction > 1;
  const near = fraction >= 0.85;
  const color = over ? 'var(--rose)' : near ? 'var(--iris)' : 'var(--sky)';
  const outerR = 36;
  const outerStroke = 8;
  const outerC = 2 * Math.PI * outerR;
  const innerR = 25;
  const innerStroke = 4.5;
  const innerC = 2 * Math.PI * innerR;
  const excess = Math.min(Math.max(fraction - 1, 0), 1);
  // Outer ring fills first; the overage ring follows once it's full.
  const fillTransition = useReducedTransition(spring.smooth);
  const overageTransition = useReducedTransition({ ...spring.smooth, delay: 0.35 });

  return (
    <div className="shrink-0" style={{ width: size, height: size }} aria-hidden="true">
      <svg width={size} height={size} viewBox="0 0 84 84">
        <circle
          cx="42"
          cy="42"
          r={outerR}
          fill="none"
          stroke="var(--paper-sunk)"
          strokeWidth={outerStroke}
        />
        <m.circle
          cx="42"
          cy="42"
          r={outerR}
          fill="none"
          stroke={color}
          strokeWidth={outerStroke}
          strokeLinecap={over ? undefined : 'round'}
          initial={{ strokeDasharray: `0 ${outerC}` }}
          animate={{ strokeDasharray: `${outerC * Math.min(fraction, 1)} ${outerC}` }}
          transition={fillTransition}
          transform="rotate(-90 42 42)"
        />
        {over && (
          <>
            <circle
              cx="42"
              cy="42"
              r={innerR}
              fill="none"
              stroke="var(--rose-soft)"
              strokeWidth={innerStroke}
            />
            <m.circle
              cx="42"
              cy="42"
              r={innerR}
              fill="none"
              stroke="var(--rose)"
              strokeWidth={innerStroke}
              strokeLinecap="round"
              initial={{ strokeDasharray: `0 ${innerC}` }}
              animate={{ strokeDasharray: `${innerC * excess} ${innerC}` }}
              transition={overageTransition}
              transform="rotate(-90 42 42)"
            />
          </>
        )}
        <line x1="42" y1="1.4" x2="42" y2="10.6" stroke="var(--paper-raised)" strokeWidth="2.6" />
      </svg>
    </div>
  );
};
