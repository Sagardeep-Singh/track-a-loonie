import type { HistoryPoint } from '@/lib/services/accountBalances';

const money = (value: number): string =>
  new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(value);

/** Compact axis tick label, e.g. -40000 -> "-$40k". */
const moneyCompact = (value: number): string => {
  const sign = value < 0 ? '-' : '';
  const abs = Math.abs(value);
  return abs >= 1000 ? `${sign}$${Math.round(abs / 1000)}k` : `${sign}$${Math.round(abs)}`;
};

const WIDTH = 600;
const HEIGHT = 170;
const PAD_LEFT = 48;
// room for the last month's centered label so it isn't clipped at the edge
const PAD_X = 20;
const PAD_TOP = 10;
const PAD_BOTTOM = 22;
const USABLE_WIDTH = WIDTH - PAD_LEFT - PAD_X;
const USABLE_HEIGHT = HEIGHT - PAD_TOP - PAD_BOTTOM;

const xAt = (i: number, count: number): number =>
  count > 1 ? PAD_LEFT + (i / (count - 1)) * USABLE_WIDTH : (PAD_LEFT + WIDTH) / 2;

type PlottedPoint = HistoryPoint & { i: number; balance: number };

/**
 * One account's (or net worth's) month-end balance as a single line. A
 * single series needs no legend: the surrounding card names it. The y-scale
 * always includes 0 so a liability or a dip below zero reads honestly, and
 * months with no data yet are left blank rather than drawn as 0.
 */
export const BalanceLineChart = ({
  points,
  label,
}: {
  points: HistoryPoint[];
  /** accessible name, e.g. "TFSA balance by month" */
  label: string;
}): React.ReactElement => {
  const plotted = points
    .map((p, i) => ({ ...p, i }))
    .filter((p): p is PlottedPoint => p.balance !== null);
  if (plotted.length === 0) {
    return <p className="text-ink-muted py-10 text-center text-sm">No balance history yet.</p>;
  }

  const max = Math.max(0, ...plotted.map((p) => p.balance));
  const min = Math.min(0, ...plotted.map((p) => p.balance));
  // a flat line at 0 still needs a scale to sit on
  const span = max - min || 1;
  const yAt = (value: number): number => PAD_TOP + ((max - value) / span) * USABLE_HEIGHT;
  const count = points.length;
  // 24 labels don't fit across 600px; every other one (ending on this month) does
  const labelEvery = count > 12 ? 2 : 1;
  const path = plotted
    .map((p, j) => `${j === 0 ? 'M' : 'L'}${xAt(p.i, count)},${yAt(p.balance)}`)
    .join(' ');
  const last = plotted[plotted.length - 1]!;
  const ticks = min < 0 && max > 0 ? [max, 0, min] : [max, (max + min) / 2, min];

  return (
    <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="w-full" role="img" aria-label={label}>
      {ticks.map((v, i) => (
        <g key={i}>
          <line
            x1={PAD_LEFT}
            y1={yAt(v)}
            x2={WIDTH - PAD_X}
            y2={yAt(v)}
            stroke="var(--line)"
            strokeWidth={1}
          />
          <text
            x={PAD_LEFT - 8}
            y={yAt(v) + 3}
            textAnchor="end"
            fill="var(--ink-muted)"
            className="font-mono text-[9px]"
          >
            {moneyCompact(v)}
          </text>
        </g>
      ))}
      <path
        d={path}
        fill="none"
        stroke="var(--iris)"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {points.map((p, i) =>
        (count - 1 - i) % labelEvery === 0 ? (
          <text
            key={p.month}
            x={xAt(i, count)}
            y={HEIGHT - 4}
            textAnchor="middle"
            fill="var(--ink-muted)"
            className="font-mono text-[9px]"
          >
            {p.label}
          </text>
        ) : null,
      )}
      <circle
        cx={xAt(last.i, count)}
        cy={yAt(last.balance)}
        r={4}
        fill="var(--iris)"
        stroke="var(--paper-raised)"
        strokeWidth={2}
      />
      {plotted.map((p) => (
        <circle
          key={`${p.month}-hit`}
          cx={xAt(p.i, count)}
          cy={yAt(p.balance)}
          r={9}
          fill="transparent"
        >
          <title>{`${p.label}: ${money(p.balance)}`}</title>
        </circle>
      ))}
    </svg>
  );
};
