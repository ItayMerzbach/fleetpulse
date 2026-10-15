import type { HistoryPoint } from '../types';

/** Tiny line chart of the last readings. Rejected / suspect readings (null) are gaps. */
export function Sparkline({ history, field, max }: { history: HistoryPoint[]; field: 'speed' | 'fuel' | 'engineTemp'; max: number }) {
  const width = 240;
  const height = 40;
  if (history.length < 2) return <div className="muted small">collecting data…</div>;

  let d = '';
  let penDown = false;
  history.forEach((point, i) => {
    const value = point[field];
    if (value === null) {
      penDown = false;
      return;
    }
    const x = (i / (history.length - 1)) * width;
    const y = height - (Math.min(value, max) / max) * height;
    d += `${penDown ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)} `;
    penDown = true;
  });

  return (
    <svg width={width} height={height} className="sparkline">
      <path d={d} fill="none" stroke="#2f6fd6" strokeWidth={1.5} />
    </svg>
  );
}
