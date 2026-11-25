import type { TrendsMonth } from '@/lib/services/trends';

const money = (value: number): string =>
  new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(value);

/** Compact axis tick label, e.g. $40,000 -> "$40k". */
const moneyCompact = (value: number): string =>
  value >= 1000 ? `$${Math.round(value / 1000)}k` : `$${Math.round(value)}`;

const WIDTH = 600;
const HEIGHT = 160;
const PAD_LEFT = 44;
// Room for the last month's centered label ("Sep*") so it isn't clipped at the edge.
const PAD_X = 16;
const PAD_TOP = 10;
const PAD_BOTTOM = 22;
const USABLE_WIDTH = WIDTH - PAD_LEFT - PAD_X;
const USABLE_HEIGHT = HEIGHT - PAD_TOP - PAD_BOTTOM;

const xAt = (i: number, count: number): number =>
  count > 1 ? PAD_LEFT + (i / (count - 1)) * USABLE_WIDTH : (PAD_LEFT + WIDTH) / 2;

const yAt = (value: number, max: number): number =>
  PAD_TOP + USABLE_HEIGHT - (max > 0 ? (value / max) * USABLE_HEIGHT : 0);

/**
 * Monotone cubic (Fritsch–Carlson) through each month's point, not a naive
 * Catmull-Rom spline — each point is a real discrete month, so the curve
 * must never dip below/above its neighbors and imply a value that wasn't
 * reported (the failure mode plain Catmull-Rom has on non-monotone data).
 */
const smoothPath = (values: number[], max: number): string => {
  const n = values.length;
  const xs = values.map((_, i) => xAt(i, n));
  const ys = values.map((v) => yAt(v, max));
  if (n < 2) return '';
  if (n === 2) return `M${xs[0]},${ys[0]} L${xs[1]},${ys[1]}`;

  const d = xs.map((_, i) => (i < n - 1 ? (ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]) : 0));
  const m = xs.map((_, i) => {
    if (i === 0) return d[0];
    if (i === n - 1) return d[n - 2];
    return d[i - 1] === 0 || d[i] === 0 || d[i - 1] * d[i] < 0 ? 0 : (d[i - 1] + d[i]) / 2;
  });

  let path = `M${xs[0]},${ys[0]}`;
  for (let i = 0; i < n - 1; i++) {
    const dx = (xs[i + 1] - xs[i]) / 3;
    const c1x = xs[i] + dx;
    const c1y = ys[i] + m[i] * dx;
    const c2x = xs[i + 1] - dx;
    const c2y = ys[i + 1] - m[i + 1] * dx;
    path += ` C${c1x},${c1y} ${c2x},${c2y} ${xs[i + 1]},${ys[i + 1]}`;
  }
  return path;
};

/**
 * Income vs. expense across the selected range — one chart, two series
 * sharing a single $ measure, per the dataviz skill's "same job -> one
 * chart" rule. Two series is comfortable with color alone plus direct
 * end-labels, so this reuses the app's existing sky/rose semantic tokens
 * rather than the categorical chart-N palette, matching the In/Out
 * convention already used on Overview.
 */
export const SpendingLineChart = ({
  months,
  currentMonth,
}: {
  months: TrendsMonth[];
  /** the viewer's current YYYYMM, resolved on the server */
  currentMonth: number;
}): React.ReactElement => {
  const max = Math.max(1, ...months.flatMap((m) => [m.income, m.expense]));
  const income = months.map((m) => m.income);
  const expense = months.map((m) => m.expense);
  const lastX = xAt(months.length - 1, months.length);
  const isEmpty = months.every((m) => m.income === 0 && m.expense === 0);

  return (
    <div>
      <div className="mb-3.5 flex items-center gap-4">
        <span className="text-ink-muted flex items-center gap-1.5 text-[12.5px]">
          <span className="bg-sky inline-block size-2.5 rounded-full" /> In
        </span>
        <span className="text-ink-muted flex items-center gap-1.5 text-[12.5px]">
          <span className="bg-rose inline-block size-2.5 rounded-full" /> Out
        </span>
      </div>
      {isEmpty ? (
        <p className="text-ink-muted py-10 text-center text-sm">No transactions in this range.</p>
      ) : (
        <svg
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          className="w-full"
          role="img"
          aria-label="Income and expense by month"
        >
          <line
            x1={PAD_LEFT}
            y1={PAD_TOP}
            x2={WIDTH - PAD_X}
            y2={PAD_TOP}
            stroke="var(--line)"
            strokeWidth={1}
          />
          <line
            x1={PAD_LEFT}
            y1={PAD_TOP + USABLE_HEIGHT / 2}
            x2={WIDTH - PAD_X}
            y2={PAD_TOP + USABLE_HEIGHT / 2}
            stroke="var(--line)"
            strokeWidth={1}
          />
          <line
            x1={PAD_LEFT}
            y1={HEIGHT - PAD_BOTTOM}
            x2={WIDTH - PAD_X}
            y2={HEIGHT - PAD_BOTTOM}
            stroke="var(--line)"
            strokeWidth={1}
          />
          {[max, max / 2, 0].map((v, i) => (
            <text
              key={i}
              x={PAD_LEFT - 8}
              y={PAD_TOP + (i / 2) * USABLE_HEIGHT + 3}
              textAnchor="end"
              fill="var(--ink-muted)"
              className="font-mono text-[9px]"
            >
              {moneyCompact(v)}
            </text>
          ))}
          <path
            d={smoothPath(income, max)}
            fill="none"
            stroke="var(--sky)"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d={smoothPath(expense, max)}
            fill="none"
            stroke="var(--rose)"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          {months.map((m, i) => {
            const isPartial = m.month === currentMonth;
            return (
              <text
                key={m.month}
                x={xAt(i, months.length)}
                y={HEIGHT - 4}
                textAnchor="middle"
                fill="var(--ink-muted)"
                className="font-mono text-[9px]"
              >
                {/* "*" rather than "· partial": at a dense range (12 points
                    across 600px) the longer suffix collides with its
                    neighbor's label — the bar chart below already spells out
                    "in progress" in full where there's room per month. */}
                {isPartial ? `${m.label}*` : m.label}
                {isPartial && <title>{`${m.label} is still in progress`}</title>}
              </text>
            );
          })}
          <circle
            cx={lastX}
            cy={yAt(income[income.length - 1], max)}
            r={4}
            fill="var(--sky)"
            stroke="var(--paper-raised)"
            strokeWidth={2}
          />
          <circle
            cx={lastX}
            cy={yAt(expense[expense.length - 1], max)}
            r={4}
            fill="var(--rose)"
            stroke="var(--paper-raised)"
            strokeWidth={2}
          />
          {months.map((m, i) => (
            <circle
              key={`${m.month}-income`}
              cx={xAt(i, months.length)}
              cy={yAt(m.income, max)}
              r={8}
              fill="transparent"
            >
              <title>{`${m.label} income: ${money(m.income)}`}</title>
            </circle>
          ))}
          {months.map((m, i) => (
            <circle
              key={`${m.month}-expense`}
              cx={xAt(i, months.length)}
              cy={yAt(m.expense, max)}
              r={8}
              fill="transparent"
            >
              <title>{`${m.label} expense: ${money(m.expense)}`}</title>
            </circle>
          ))}
        </svg>
      )}
    </div>
  );
};
